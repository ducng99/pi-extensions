import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { findSourceRepo, initShadowRepo, seedShadowRepo, type ShadowGitConfig } from "../src/shadow-git";
import { SnapshotStore } from "../src/snapshots";

function mockCtx() {
    return {
        ui: {
            notify: mock(() => { }),
            confirm: mock(async () => true),
        },
        sessionManager: {
            getEntry: mock(() => undefined),
            getLeafId: mock(() => null),
            getSessionId: mock(() => "test-session-id"),
            getSessionFile: mock(() => undefined),
        },
    } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;
}

function writeFile(dir: string, relativePath: string, content: string): void {
    const absPath = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, "utf8");
}

async function runGit(cwd: string, args: string[], env?: Record<string, string>): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
    const { spawn } = await import("child_process");
    return new Promise((resolve) => {
        const proc = spawn("git", args, { cwd, env: env ? { ...process.env, ...env } : process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        let stdout = "";
        let stderr = "";
        proc.stdin.end();
        proc.stdout.on("data", (d: Buffer) => {
            stdout += d.toString();
        });
        proc.stderr.on("data", (d: Buffer) => {
            stderr += d.toString();
        });
        proc.on("close", (code) => {
            resolve({ ok: code === 0, stdout, stderr: stderr.trim(), exitCode: code ?? 1 });
        });
        proc.on("error", () => {
            resolve({ ok: false, stdout: "", stderr: "spawn failed", exitCode: 1 });
        });
    });
}

async function initSourceRepo(tmpDir: string): Promise<void> {
    const r = await runGit(tmpDir, ["init"]);
    if (!r.ok) throw new Error(r.stderr);
    await runGit(tmpDir, ["config", "user.email", "test@local"]);
    await runGit(tmpDir, ["config", "user.name", "test"]);
}

async function makeStore(tmpDir: string, sessionKey = "test-session"): Promise<SnapshotStore> {
    const source = await findSourceRepo(tmpDir);
    if (!source) throw new Error("source repo not found");
    const config: ShadowGitConfig = {
        shadowDir: path.join(tmpDir, "shadow"),
        cwd: tmpDir,
        sessionKey,
        source,
    };
    const ctx = mockCtx();
    await initShadowRepo(config.shadowDir, config.cwd, ctx);
    await seedShadowRepo(config.shadowDir, config.cwd, source);
    return new SnapshotStore(config);
}

// ============================================================================
// SnapshotStore
// ============================================================================

describe("SnapshotStore", () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-rollback-snapshot-"));
        await initSourceRepo(tmpDir);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("snapshot captures modified tracked file", async () => {
        writeFile(tmpDir, "a.txt", "v1");
        await runGit(tmpDir, ["add", "a.txt"]);
        await runGit(tmpDir, ["commit", "-m", "init"]);

        const store = await makeStore(tmpDir);
        await store.ensureInitial(mockCtx());

        writeFile(tmpDir, "a.txt", "v2");
        const hash = await store.createSnapshot("entry-1", mockCtx());
        expect(hash).toBeDefined();
        expect(hash).toMatch(/^[0-9a-f]{40}$/);
        expect(store.getAll().get("entry-1")).toBe(hash);
    });

    test("returns undefined when clean", async () => {
        writeFile(tmpDir, "a.txt", "v1");
        await runGit(tmpDir, ["add", "a.txt"]);
        await runGit(tmpDir, ["commit", "-m", "init"]);

        const store = await makeStore(tmpDir);
        await store.ensureInitial(mockCtx());

        const hash = await store.createSnapshot("entry-1", mockCtx());
        expect(hash).toBeUndefined();
    });

    test("untracked file created by any tool is captured", async () => {
        const store = await makeStore(tmpDir);
        await store.ensureInitial(mockCtx());

        writeFile(tmpDir, "new.txt", "created");
        const hash = await store.createSnapshot("entry-1", mockCtx());
        expect(hash).toBeDefined();
        expect(store.getAll().get("entry-1")).toBe(hash);
    });

    test("gitignored file is excluded", async () => {
        writeFile(tmpDir, ".gitignore", ".env\n");
        await runGit(tmpDir, ["add", ".gitignore"]);
        await runGit(tmpDir, ["commit", "-m", "gitignore"]);

        const store = await makeStore(tmpDir);
        await store.ensureInitial(mockCtx());

        writeFile(tmpDir, ".env", "SECRET=1");
        const hash = await store.createSnapshot("entry-1", mockCtx());
        expect(hash).toBeUndefined();
        expect(store.getAll().get("entry-1")).toBeUndefined();
    });

    test("newly-ignored file is dropped from later trees", async () => {
        const store = await makeStore(tmpDir);
        await store.ensureInitial(mockCtx());

        writeFile(tmpDir, ".env", "SECRET=1");
        const hash1 = await store.createSnapshot("entry-1", mockCtx());
        expect(hash1).toBeDefined();

        writeFile(tmpDir, ".gitignore", ".env\n");
        await runGit(tmpDir, ["add", ".gitignore"]);
        await runGit(tmpDir, ["commit", "-m", "gitignore"]);

        const hash2 = await store.createSnapshot("entry-2", mockCtx());
        expect(hash2).toBeDefined();
        expect(hash2).not.toBe(hash1);
    });

    test("> 2 MB untracked file is blocked", async () => {
        const store = await makeStore(tmpDir);
        await store.ensureInitial(mockCtx());

        const largePath = path.join(tmpDir, "large.bin");
        fs.writeFileSync(largePath, Buffer.alloc(2 * 1024 * 1024 + 1024));
        const hash = await store.createSnapshot("entry-1", mockCtx());
        expect(hash).toBeUndefined();
        // File should be excluded from future snapshots.
        const hash2 = await store.createSnapshot("entry-2", mockCtx());
        expect(hash2).toBeUndefined();
    });

    test("ensureInitial plus deep-rollback fallback", async () => {
        writeFile(tmpDir, "existing.txt", "original");
        await runGit(tmpDir, ["add", "existing.txt"]);
        await runGit(tmpDir, ["commit", "-m", "init"]);

        const store = await makeStore(tmpDir);
        const initial = await store.ensureInitial(mockCtx());
        expect(initial).toBeDefined();

        writeFile(tmpDir, "existing.txt", "modified");
        writeFile(tmpDir, "new.txt", "created");
        await store.createSnapshot("entry-1", mockCtx());

        const fallback = await store.findSnapshot("earlier-entry", mockCtx());
        expect(fallback).toBe(initial);
    });

    test("persistence reload simulates restart", async () => {
        writeFile(tmpDir, "a.txt", "v1");
        await runGit(tmpDir, ["add", "a.txt"]);
        await runGit(tmpDir, ["commit", "-m", "init"]);

        const store = await makeStore(tmpDir, "restart-session");
        await store.ensureInitial(mockCtx());
        writeFile(tmpDir, "a.txt", "v2");
        const hash = await store.createSnapshot("entry-1", mockCtx());
        expect(hash).toBeDefined();

        const store2 = await makeStore(tmpDir, "restart-session");
        const found = await store2.findSnapshot("entry-1", mockCtx());
        expect(found).toBe(hash);
    });

    test("resolves per-tool snapshot from a toolResult entry", async () => {
        const store = await makeStore(tmpDir);
        await store.ensureInitial(mockCtx());

        writeFile(tmpDir, "a.txt", "after call 1");
        const hash1 = await store.createSnapshot("assistant-abc:call_1", mockCtx());
        writeFile(tmpDir, "a.txt", "after call 2");
        const hash2 = await store.createSnapshot("assistant-abc:call_2", mockCtx());
        expect(hash1).toBeDefined();
        expect(hash2).toBeDefined();
        expect(hash1).not.toBe(hash2);

        const ctxWithTree = {
            ...mockCtx(),
            sessionManager: {
                ...mockCtx().sessionManager,
                getEntry: mock((id: string) => {
                    if (id === "assistant-abc") return { id: "assistant-abc", parentId: "user-x", type: "message", message: { role: "assistant" } };
                    if (id === "toolR1") return { id: "toolR1", parentId: "assistant-abc", type: "message", message: { role: "toolResult", toolCallId: "call_1" } };
                    if (id === "toolR2") return { id: "toolR2", parentId: "assistant-abc", type: "message", message: { role: "toolResult", toolCallId: "call_2" } };
                    return undefined;
                }),
            },
        } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;

        expect(await store.findSnapshot("toolR1", ctxWithTree)).toBe(hash1);
        expect(await store.findSnapshot("toolR2", ctxWithTree)).toBe(hash2);
        expect(await store.findSnapshot("assistant-abc", ctxWithTree)).toBe(store.getInitialStateCommit());
    });
});
