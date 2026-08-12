// Bounded session context delivered to the bash command classifier.
//
// Everything here derives from `ctx.sessionManager.getEntries()` — the single
// source of truth for session history — plus a lazy `git status`/remote-host
// snapshot (working-tree state that isn't in the session entries). No event
// subscriptions, no parallel rolling state: the session manager already has
// the tool calls, results, and user prompts; we just project a compact view
// of them at classification time. Per-command memoization in `permission-check`
// ensures one `git status` per command (shared across all leaves), so no
// inter-command cache is needed here.

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Bounded, compact view of the current session, fed to the classifier. */
export interface ClassifierSessionContext {
    /** Current working directory. Always populated. */
    cwd: string;
    /** Host parsed from the repo's configured remote (e.g. "github.com"). Undefined if not a git repo. */
    gitRemote?: string;
    /** `git status --porcelain` output, truncated. Undefined when not a repo or git unavailable. */
    gitStatus?: string;
    /** Last ~12 tool calls as compact `"name: arg"` strings, oldest first. Derived from assistant messages in the session entries. */
    recentToolCalls?: string[];
    /** Paths touched by read/edit/write tool calls in this session (bounded), in encounter order. Derived from assistant tool_use blocks. */
    agentTouchedFiles?: string[];
    /** Most recent user prompt, truncated ~300 chars. */
    lastUserPrompt?: string;
}

/** Shape of `pi.exec` used here — only what we need to stub for tests. */
export interface ExecFn {
    (command: string, args: string[], options?: { cwd?: string; signal?: AbortSignal; timeout?: number }): Promise<{
        stdout: string;
        stderr: string;
        code: number;
        killed: boolean;
    }>;
}

// Bounding constants. Keep the block tiny — one-token local model.
const MAX_RECENT_TOOL_CALLS = 12;
const MAX_AGENT_TOUCHED_FILES = 30;
const MAX_BASH_ARG = 120;
const MAX_USER_PROMPT = 300;
const MAX_GIT_STATUS_LINES = 40;
const MAX_GIT_STATUS_BYTES = 2048;
/** Cap on how many session entries we scan backward. Live history since the last compaction is what matters; older entries are summarized. */
const MAX_ENTRIES_SCAN = 400;

function truncate(s: string, max: number): string {
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ---------------------------------------------------------------------------
// Narrow local views of the message/content shapes we read. We only need a
// few discriminated fields, so duck-type against the stable `type`/`role`
// discriminators instead of importing the full provider-message union.
// ---------------------------------------------------------------------------

type ContentBlock
    = | { type: "text"; text: string }
        | { type: "toolCall"; name: string; arguments: Record<string, unknown> };

interface LikeMessage {
    role: string;
    content?: string | ContentBlock[];
}

interface LikeMessageEntry {
    type: "message";
    message: LikeMessage;
}

function isMessageEntry(e: SessionEntry): e is SessionEntry & LikeMessageEntry {
    return e.type === "message";
}

/** Extract a compact `"name: arg"` summary from a toolCall's arguments. */
function summarizeToolCall(name: string, args: Record<string, unknown>): string {
    let arg = "";
    switch (name) {
        case "bash":
            arg = typeof args.command === "string" ? args.command : "";
            break;
        case "edit":
        case "write":
            arg = typeof args.file_path === "string"
                ? args.file_path
                : (typeof args.path === "string" ? args.path : "");
            break;
        case "read":
            arg = typeof args.path === "string"
                ? args.path
                : (typeof args.file_path === "string" ? args.file_path : "");
            break;
        case "ls":
        case "find":
            arg = typeof args.path === "string" ? args.path : "";
            break;
        case "grep":
            arg = typeof args.pattern === "string" ? String(args.pattern) : "";
            break;
        // default: arg stays "" (set by the initial assignment)
    }
    if (name === "bash") arg = truncate(arg, MAX_BASH_ARG);
    return `${name}: ${arg}`;
}

/** Extract a touched file path from a read/edit/write toolCall. */
function touchedFilePath(name: string, args: Record<string, unknown>): string | null {
    if (name === "edit" || name === "write") {
        const fp = args.file_path ?? args.path;
        return typeof fp === "string" ? fp : null;
    }
    if (name === "read") {
        const fp = args.path ?? args.file_path;
        return typeof fp === "string" ? fp : null;
    }
    return null;
}

/** Extract the text of a user message (string content or concatenated text blocks). */
function userMessageText(content: LikeMessage["content"]): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((b): b is { type: "text"; text: string } => b?.type === "text")
        .map(b => b.text)
        .join("\n")
        .trim();
}

/** Parse the hostname out of a git remote URL (SSH or HTTPS forms). */
function parseRemoteHost(url: string): string | undefined {
    // git@github.com:org/repo.git  →  github.com
    const scp = url.match(/^[\w.]+@([^:/]+):/);
    if (scp) return scp[1];
    // https://github.com/org/repo.git  |  ssh://git@github.com:22/org/repo.git  →  github.com
    try {
        const u = new URL(url.includes("://") ? url : `https://${url}`);
        return u.hostname || undefined;
    }
    catch {
        return undefined;
    }
}

/**
 * Build the {@link ClassifierSessionContext} for one classification by
 * projecting the session entries (recent tool calls, touched files, last
 * user prompt) and consulting `git` lazily.
 *
 * The entries scan walks backward from the most recent entry and stops at the
 * latest compaction (older history is summarized) or after a cap, so a long
 * session doesn't make classification expensive. All git work fails closed
 * → undefined fields; the policy treats missing context as "judge the command
 * alone," which is the safer side. Per-command memoization in the caller
 * ensures one `git status` per command (shared across all leaves).
 */
export async function buildSessionContext(
    entries: SessionEntry[],
    cwd: string,
    exec: ExecFn,
): Promise<ClassifierSessionContext> {
    const recentToolCalls: string[] = [];
    const agentTouchedFiles: string[] = [];
    let lastUserPrompt = "";

    let seen = 0;
    for (let i = entries.length - 1; i >= 0 && seen < MAX_ENTRIES_SCAN; i--, seen++) {
        const entry = entries[i]!;
        if (entry.type === "compaction") {
            // History before the latest compaction is a summary, not "this
            // session's" live agent activity — stop scanning.
            break;
        }
        if (!isMessageEntry(entry)) continue;
        const msg = entry.message;
        if (!msg) continue;

        // Most-recent-first user message wins; stop looking once we have one.
        if (msg.role === "user" && !lastUserPrompt) {
            const text = userMessageText(msg.content);
            if (text) lastUserPrompt = text;
        }

        if (msg.role === "assistant" && Array.isArray(msg.content)) {
            // Assistant messages carry toolCall blocks. Iterate in document
            // order so within-message calls append oldest→newest; the outer
            // reverse pass keeps later messages' calls later in the list.
            for (const block of msg.content) {
                if (block?.type !== "toolCall") continue;
                const { name, arguments: args } = block;
                if (typeof name !== "string" || !args) continue;

                recentToolCalls.unshift(summarizeToolCall(name, args));

                const touched = touchedFilePath(name, args);
                if (touched && !agentTouchedFiles.includes(touched)) {
                    agentTouchedFiles.unshift(touched);
                }
            }
        }

        if (recentToolCalls.length >= MAX_RECENT_TOOL_CALLS
            && agentTouchedFiles.length >= MAX_AGENT_TOUCHED_FILES) {
            break;
        }
    }

    const ctx: ClassifierSessionContext = {
        cwd,
        // The backward scan + unshift yields oldest-first arrays; keep the
        // NEWEST N by slicing the tail, not the head.
        recentToolCalls: recentToolCalls.slice(-MAX_RECENT_TOOL_CALLS),
        agentTouchedFiles: agentTouchedFiles.slice(-MAX_AGENT_TOUCHED_FILES),
        lastUserPrompt: lastUserPrompt ? truncate(lastUserPrompt, MAX_USER_PROMPT) : undefined,
    };

    const remote = await resolveRemoteHost(exec, cwd);
    if (remote) ctx.gitRemote = remote;

    const status = await resolveGitStatus(exec, cwd);
    if (status) ctx.gitStatus = status;

    return ctx;
}

async function resolveRemoteHost(exec: ExecFn, cwd: string): Promise<string | undefined> {
    try {
        let res = await exec("git", ["remote", "get-url", "origin"], { cwd, timeout: 3000 });
        if (res.code !== 0) {
            // No `origin`; fall back to the first remote of any name.
            res = await exec("git", ["remote"], { cwd, timeout: 3000 });
            if (res.code !== 0 || !res.stdout.trim()) return undefined;
            const first = res.stdout.split("\n")[0]!.trim();
            res = await exec("git", ["remote", "get-url", first], { cwd, timeout: 3000 });
            if (res.code !== 0) return undefined;
        }
        return parseRemoteHost(res.stdout.trim());
    }
    catch {
        return undefined;
    }
}

async function resolveGitStatus(exec: ExecFn, cwd: string): Promise<string | undefined> {
    try {
        // --porcelain=v1 is stable and compact; the leading space on lines like
        // ` M file` is the 2-char status field, so trimEnd() only — never trim
        // the start. Untracked files are included by default, which is what
        // surfaces a `.env` about to be committed.
        const res = await exec("git", ["status", "--porcelain=v1"], { cwd, timeout: 3000 });
        if (res.code !== 0) return undefined;
        const out = res.stdout.trimEnd();
        return truncate(
            out.split("\n").slice(0, MAX_GIT_STATUS_LINES).join("\n"),
            MAX_GIT_STATUS_BYTES,
        ) || undefined;
    }
    catch {
        return undefined;
    }
}
