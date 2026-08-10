/**
 * File Rollback Extension
 *
 * Snapshots the working directory state after each mutating tool result (keyed
 * by issuing assistant entry + tool call id) and restores those snapshots when
 * the user rolls back to a specific conversation point via /tree. Uses a
 * shadow git repository stored in ~/.pi/agent/file-rollback/<projectHash>/.git
 * to avoid polluting the project directory.
 *
 * This mirrors opencode's snapshot engine: snapshots are git tree hashes
 * (never commits), the shadow repo is seeded from the source repo, and the
 * extension is silent when the project is not a git repo.
 */

import type {
    ExtensionAPI,
    ExtensionContext,
    SessionBeforeTreeEvent,
    SessionShutdownEvent,
    SessionStartEvent,
    SessionTreeEvent,
    ToolExecutionEndEvent,
    ToolExecutionStartEvent,
} from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";

import { checkRestore, restoreToSnapshot } from "./src/restore";
import {
    deriveSessionHash,
    findSourceRepo,
    getShadowDir,
    gitShadow,
    hashCwd,
    initShadowRepo,
    PRUNE,
    seedShadowRepo,
    type ShadowGitConfig,
    withRepoLock,
} from "./src/shadow-git";
import { SnapshotStore } from "./src/snapshots";

interface ExtensionState {
    config: ShadowGitConfig;
    snapshots: SnapshotStore;
    gcInterval?: ReturnType<typeof setInterval>;
}

/**
 * Find the assistant message entry that issued the tool call(s) currently
 * executing. toolResult entries are appended only after tool execution fully
 * completes, so the live leaf may be a previous turn's tool; walk up the
 * parent chain to the nearest assistant message.
 */
function getIssuingAssistantId(ctx: ExtensionContext): string | undefined {
    let currentId: string | null = ctx.sessionManager.getLeafId() ?? null;
    const visited = new Set<string>();
    while (currentId) {
        if (visited.has(currentId)) {
            break;
        }
        visited.add(currentId);
        const entry = ctx.sessionManager.getEntry?.(currentId) as
            | { id?: string; type?: string; parentId?: string | null; message?: { role?: string } }
            | undefined;
        if (entry?.type === "message" && entry.message?.role === "assistant") {
            return entry.id;
        }
        if (!entry?.parentId) {
            break;
        }
        currentId = entry.parentId;
    }
    return undefined;
}

/** Module-level state map keyed by session ID. */
const stateMap = new Map<string, ExtensionState>();

/**
 * Tools that provably cannot modify the working tree. If a tool is NOT in this
 * set, assume it may mutate the tree and run a full git snapshot.
 */
const READ_ONLY_TOOLS = new Set([
    "read",
    "ls",
    "grep",
    "find",
    "webfetch",
    "websearch",
    "ask_user_questions",
    "lsp_diagnostics",
]);

function getState(sessionId: string): ExtensionState | undefined {
    return stateMap.get(sessionId);
}

function gcIfDue(state: ExtensionState, ctx: ExtensionContext): void {
    const { shadowDir } = state.config;
    const lastGcFile = path.join(shadowDir, ".gc-last");
    const now = Date.now();
    let last = 0;
    try {
        if (fs.existsSync(lastGcFile)) {
            last = parseInt(fs.readFileSync(lastGcFile, "utf8").trim(), 10) || 0;
        }
    }
    catch {
        // ignore
    }

    if (now - last < 60 * 60 * 1000) return;

    void runGc(state, ctx).finally(() => {
        try {
            fs.writeFileSync(lastGcFile, String(now), "utf8");
        }
        catch {
            // ignore
        }
    });
}

async function runGc(state: ExtensionState, ctx: ExtensionContext): Promise<void> {
    await withRepoLock(state.config.shadowDir, async () => {
        const result = await gitShadow(state.config.shadowDir, state.config.cwd, ["gc", `--prune=${PRUNE}`], ctx);
        if (!result.ok) {
            ctx.ui.notify(`Snapshot cleanup failed: ${result.stderr}`, "warning");
        }
    });
}

export default function fileRollbackExtension(pi: ExtensionAPI) {
    pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
        const source = await findSourceRepo(ctx.cwd);
        if (!source) {
            // Extension is disabled when the project is not a git repo.
            return;
        }

        const sessionId = ctx.sessionManager.getSessionId();
        const sessionFile = ctx.sessionManager.getSessionFile();
        const sessionHash = deriveSessionHash(sessionFile, sessionId);
        const cwdHash = hashCwd(ctx.cwd);
        const shadowDir = getShadowDir(cwdHash);

        const config: ShadowGitConfig = {
            shadowDir,
            cwd: ctx.cwd,
            sessionKey: sessionHash,
            source,
        };

        // Initialize shadow repo and seed from source.
        await initShadowRepo(shadowDir, ctx.cwd, ctx);
        await seedShadowRepo(shadowDir, ctx.cwd, source);

        const snapshots = new SnapshotStore(config);

        // Hourly GC. The timer is unref'd and the last-run timestamp is stored
        // so forks/resumes do not spam gc.
        const gcInterval = setInterval(() => {
            const state = getState(sessionId);
            if (state) gcIfDue(state, ctx);
        }, 60 * 60 * 1000);
        gcInterval.unref?.();

        stateMap.set(sessionId, { config, snapshots, gcInterval });
    });

    pi.on("session_shutdown", (event: SessionShutdownEvent, ctx: ExtensionContext) => {
        const state = getState(ctx.sessionManager.getSessionId());
        if (state?.gcInterval) {
            clearInterval(state.gcInterval);
        }
        stateMap.delete(ctx.sessionManager.getSessionId());
    });

    pi.on("tool_execution_start", async (event: ToolExecutionStartEvent, ctx: ExtensionContext) => {
        const state = getState(ctx.sessionManager.getSessionId());
        if (!state) return;

        // Lazy initial baseline: capture the pre-pi working tree before the
        // first mutating tool runs.
        await state.snapshots.ensureInitial(ctx);
    });

    // Snapshot per tool result so /tree can roll back to a specific tool call.
    pi.on("tool_execution_end", async (event: ToolExecutionEndEvent, ctx: ExtensionContext) => {
        const state = getState(ctx.sessionManager.getSessionId());
        if (!state) return;

        if (READ_ONLY_TOOLS.has(event.toolName)) return;

        const assistantId = getIssuingAssistantId(ctx);
        if (!assistantId) return;
        const snapshotKey = `${assistantId}:${event.toolCallId}`;

        await state.snapshots.createSnapshot(snapshotKey, ctx);
    });

    pi.on("session_before_tree", async (event: SessionBeforeTreeEvent, ctx: ExtensionContext) => {
        const state = getState(ctx.sessionManager.getSessionId());
        if (!state) return;

        const targetId = event.preparation.targetId;
        const action = await checkRestore(targetId, state.snapshots, state.config, ctx);
        if (action === "cancel") {
            return { cancel: true };
        }
        // "no" → skip restore, tree navigation continues
        // "yes" → session_tree handler will restore files
    });

    pi.on("session_tree", async (event: SessionTreeEvent, ctx: ExtensionContext) => {
        const state = getState(ctx.sessionManager.getSessionId());
        if (!state || !event.newLeafId) return;

        const snapshot = await state.snapshots.findSnapshot(event.newLeafId, ctx);
        if (!snapshot) {
            ctx.ui.notify("No file snapshot for this point", "info");
            return;
        }

        await restoreToSnapshot(snapshot, state.config, ctx);
    });
}
