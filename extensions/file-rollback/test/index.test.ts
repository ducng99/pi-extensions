/**
 * End-to-end event wiring tests for the file-rollback extension index.
 *
 * Exercises the real session_start / tool_execution_start /
 * tool_execution_end / session_before_tree / session_tree handlers wired up
 * by the extension factory against a real temp git repo, with the shadow
 * repo redirected under a temp HOME so tests never touch ~/.pi.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { default as fileRollbackExtension } from "../index";
import { hashCwd } from "../src/shadow-git";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

function makeHarness(): { handlers: Map<string, Handler> } {
    const handlers = new Map<string, Handler>();
    const fakePi = {
        on: (ev: string, handler: Handler) => {
            handlers.set(ev, handler);
        },
    };
    fileRollbackExtension(fakePi as never);
    return { handlers };
}

function writeFile(dir: string, relativePath: string, content: string): void {
    const absPath = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, "utf8");
}

function readFile(dir: string, relativePath: string): string {
    return fs.readFileSync(path.join(dir, relativePath), "utf8");
}

function runGit(cwd: string, args: string[]): Promise<{ ok: boolean; stderr: string }> {
    return new Promise((resolve) => {
        const proc = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        let stderr = "";
        proc.stdin.end();
        proc.stderr.on("data", (d: Buffer) => {
            stderr += d.toString();
        });
        proc.on("close", (code) => {
            resolve({ ok: code === 0, stderr: stderr.trim() });
        });
        proc.on("error", () => {
            resolve({ ok: false, stderr: "spawn failed" });
        });
    });
}

describe("file-rollback index event wiring", () => {
    let tmpDir: string;
    let realHome: string | undefined;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-rollback-index-"));
        const init = await runGit(tmpDir, ["init"]);
        if (!init.ok) throw new Error(init.stderr);

        // Redirect HOME so the shadow repo lands in a temp location.
        realHome = process.env.HOME;
        process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "file-rollback-home-"));
    });

    afterEach(() => {
        if (realHome === undefined) {
            delete process.env.HOME;
        }
        else {
            process.env.HOME = realHome;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Build one ctx (fixed session ID) whose select dialog result can be
     * changed between phases of a test.
     */
    function makeCtx() {
        const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
        let selectResult: string | undefined;
        const ui = {
            notify: mock(() => {}),
            select: mock(async () => selectResult as string),
        };
        const entries: Record<string, unknown> = {
            "assistant-1": { id: "assistant-1", type: "message", parentId: null, message: { role: "assistant" } },
            "target-node": {
                id: "target-node",
                type: "message",
                parentId: "assistant-1",
                message: { role: "toolResult", toolCallId: "call-1" },
            },
        };
        const sessionManager = {
            getSessionId: mock(() => sessionId),
            getSessionFile: mock(() => undefined),
            getLeafId: mock(() => "assistant-1"),
            getEntry: mock((id: string) => entries[id]),
        };
        const ctx = { cwd: tmpDir, ui, sessionManager } as never;
        const setSelect = (value: string | undefined) => {
            selectResult = value;
        };
        return { ctx, ui, sessionId, setSelect };
    }

    /**
     * Drive the handlers to the point where the worktree has a snapshot at
     * "v2" and has since diverged to "v3":
     *   session_start → tool_execution_start (baseline) → write v2 →
     *   tool_execution_end (snapshot "assistant-1:call-1") → write v3
     */
    async function setupDivergedState(handlers: Map<string, Handler>, ctx: unknown) {
        await handlers.get("session_start")!({ reason: "startup" }, ctx);
        await handlers.get("tool_execution_start")!({ toolName: "bash", toolCallId: "call-1" }, ctx);

        writeFile(tmpDir, "a.txt", "v2");
        await handlers.get("tool_execution_end")!({ toolName: "bash", toolCallId: "call-1" }, ctx);

        writeFile(tmpDir, "a.txt", "v3");
    }

    test("selecting 'No — keep current files' does NOT revert files", async () => {
        const { handlers } = makeHarness();
        const { ctx, setSelect } = makeCtx();
        await setupDivergedState(handlers, ctx);

        setSelect("No — keep current files");
        const beforeTreeResult = await handlers.get("session_before_tree")!(
            { preparation: { targetId: "target-node" } },
            ctx,
        );
        expect(beforeTreeResult).toBeUndefined();

        await handlers.get("session_tree")!({ newLeafId: "target-node", oldLeafId: null }, ctx);

        // CRITICAL: files must NOT be reverted.
        expect(readFile(tmpDir, "a.txt")).toBe("v3");
    });

    test("selecting 'Yes — restore files' DOES revert files", async () => {
        const { handlers } = makeHarness();
        const { ctx, ui, setSelect } = makeCtx();
        await setupDivergedState(handlers, ctx);

        setSelect("Yes — restore files");
        await handlers.get("session_before_tree")!({ preparation: { targetId: "target-node" } }, ctx);
        expect(ui.select).toHaveBeenCalled();

        await handlers.get("session_tree")!({ newLeafId: "target-node", oldLeafId: null }, ctx);
        expect(readFile(tmpDir, "a.txt")).toBe("v2");
    });

    test("pressing Esc cancels tree navigation entirely", async () => {
        const { handlers } = makeHarness();
        const { ctx, ui } = makeCtx();
        await setupDivergedState(handlers, ctx);

        // select resolves to undefined (Esc) — no explicit setSelect needed.
        const result = await handlers.get("session_before_tree")!(
            { preparation: { targetId: "target-node" } },
            ctx,
        );
        expect(ui.select).toHaveBeenCalled();
        expect(result).toEqual({ cancel: true });
    });

    test("a stale 'no' decision from an aborted navigation does not leak into the next one", async () => {
        const { handlers } = makeHarness();
        const { ctx, setSelect } = makeCtx();
        await setupDivergedState(handlers, ctx);

        // First navigation: user says "no" but session_tree never fires
        // (e.g. summarization was aborted).
        setSelect("No — keep current files");
        await handlers.get("session_before_tree")!({ preparation: { targetId: "target-node" } }, ctx);

        // Second navigation: user says "yes" — must be prompted again and restore.
        setSelect("Yes — restore files");
        await handlers.get("session_before_tree")!({ preparation: { targetId: "target-node" } }, ctx);

        await handlers.get("session_tree")!({ newLeafId: "target-node", oldLeafId: null }, ctx);
        expect(readFile(tmpDir, "a.txt")).toBe("v2");
    });

    test("shadow repo is created under the project-keyed dir in HOME", async () => {
        const { handlers } = makeHarness();
        const { ctx } = makeCtx();
        await handlers.get("session_start")!({ reason: "startup" }, ctx);

        const shadowRoot = path.join(os.homedir(), ".pi", "agent", "file-rollback");
        const shadowDir = path.join(shadowRoot, hashCwd(tmpDir));
        expect(fs.existsSync(path.join(shadowDir, ".git"))).toBe(true);
    });
});
