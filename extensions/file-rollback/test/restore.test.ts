import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { checkRestore, restoreToSnapshot } from "../src/restore";
import { findSourceRepo, initShadowRepo, seedShadowRepo, type ShadowGitConfig } from "../src/shadow-git";
import { SnapshotStore } from "../src/snapshots";

interface MockUi {
    notify: ReturnType<typeof mock>;
    select: ReturnType<typeof mock>;
}

function makeCtx(overrides: { selectResult?: string; getEntry?: (id: string) => unknown } = {}) {
    const ui: MockUi = {
        notify: mock(() => {}),
        select: mock(async () => ("selectResult" in overrides ? overrides.selectResult : "Yes — restore files") as string),
    };
    const ctx = {
        ui,
        sessionManager: {
            getEntry: mock(overrides.getEntry ?? (() => undefined)),
            getLeafId: mock(() => null),
            getSessionId: mock(() => "test-session-id"),
            getSessionFile: mock(() => undefined),
        },
    } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;
    return { ctx, ui };
}

function writeFile(dir: string, relativePath: string, content: string): void {
    const absPath = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, "utf8");
}

function readFile(dir: string, relativePath: string): string {
    return fs.readFileSync(path.join(dir, relativePath), "utf8");
}

function exists(dir: string, relativePath: string): boolean {
    return fs.existsSync(path.join(dir, relativePath));
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
    const { ctx } = makeCtx();
    await initShadowRepo(config.shadowDir, config.cwd, ctx);
    await seedShadowRepo(config.shadowDir, config.cwd, source);
    return new SnapshotStore(config);
}

// ============================================================================
// checkRestore
// ============================================================================

describe("checkRestore", () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-rollback-restore-"));
        await initSourceRepo(tmpDir);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("returns 'yes' when no snapshot exists", async () => {
        const store = await makeStore(tmpDir);
        const { ctx } = makeCtx();
        const action = await checkRestore("no-snapshot-entry", store, store.config, ctx);
        expect(action).toBe("yes");
    });

    test("returns 'yes' and no dialog when restore is a no-op", async () => {
        writeFile(tmpDir, "a.txt", "v1");
        await runGit(tmpDir, ["add", "a.txt"]);
        await runGit(tmpDir, ["commit", "-m", "init"]);

        const store = await makeStore(tmpDir);
        await store.ensureInitial(makeCtx().ctx);
        writeFile(tmpDir, "a.txt", "v2");
        await store.createSnapshot("entry-1", makeCtx().ctx);

        // Revert back to "v2" (current state) - no-op.
        writeFile(tmpDir, "a.txt", "v2");
        const { ctx, ui } = makeCtx();
        const action = await checkRestore("entry-1", store, store.config, ctx);
        expect(action).toBe("yes");
        expect(ui.select).not.toHaveBeenCalled();
    });

    test("asks for selection with preview when restore changes files", async () => {
        writeFile(tmpDir, "a.txt", "v1");
        await runGit(tmpDir, ["add", "a.txt"]);
        await runGit(tmpDir, ["commit", "-m", "init"]);

        const store = await makeStore(tmpDir);
        await store.ensureInitial(makeCtx().ctx);
        writeFile(tmpDir, "a.txt", "v2");
        await store.createSnapshot("entry-1", makeCtx().ctx);

        writeFile(tmpDir, "a.txt", "v3");
        const { ctx, ui } = makeCtx();
        const action = await checkRestore("entry-1", store, store.config, ctx);
        expect(ui.select).toHaveBeenCalled();
        expect(action).toBe("yes");
    });

    test("returns 'no' when user selects keep current files", async () => {
        writeFile(tmpDir, "a.txt", "v1");
        await runGit(tmpDir, ["add", "a.txt"]);
        await runGit(tmpDir, ["commit", "-m", "init"]);

        const store = await makeStore(tmpDir);
        await store.ensureInitial(makeCtx().ctx);
        writeFile(tmpDir, "a.txt", "v2");
        await store.createSnapshot("entry-1", makeCtx().ctx);

        writeFile(tmpDir, "a.txt", "v3");
        const { ctx } = makeCtx({ selectResult: "No — keep current files" });
        const action = await checkRestore("entry-1", store, store.config, ctx);
        expect(action).toBe("no");
    });

    test("returns 'cancel' when user presses Esc", async () => {
        writeFile(tmpDir, "a.txt", "v1");
        await runGit(tmpDir, ["add", "a.txt"]);
        await runGit(tmpDir, ["commit", "-m", "init"]);

        const store = await makeStore(tmpDir);
        await store.ensureInitial(makeCtx().ctx);
        writeFile(tmpDir, "a.txt", "v2");
        await store.createSnapshot("entry-1", makeCtx().ctx);

        writeFile(tmpDir, "a.txt", "v3");
        const { ctx } = makeCtx({ selectResult: undefined as unknown as string });
        const action = await checkRestore("entry-1", store, store.config, ctx);
        expect(action).toBe("cancel");
    });
});

// ============================================================================
// restoreToSnapshot
// ============================================================================

describe("restoreToSnapshot", () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-rollback-restore-"));
        await initSourceRepo(tmpDir);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("restores file content to snapshot state", async () => {
        writeFile(tmpDir, "a.txt", "v1");
        await runGit(tmpDir, ["add", "a.txt"]);
        await runGit(tmpDir, ["commit", "-m", "init"]);

        const store = await makeStore(tmpDir);
        await store.ensureInitial(makeCtx().ctx);
        writeFile(tmpDir, "a.txt", "v2");
        const hash = await store.createSnapshot("entry-1", makeCtx().ctx);
        expect(hash).toBeDefined();

        writeFile(tmpDir, "a.txt", "v3");
        await restoreToSnapshot(hash!, store.config, makeCtx().ctx);
        expect(readFile(tmpDir, "a.txt")).toBe("v2");
    });

    test("deletes files created by pi after the snapshot", async () => {
        const store = await makeStore(tmpDir);
        await store.ensureInitial(makeCtx().ctx);
        writeFile(tmpDir, "a.txt", "v1");
        const hash = await store.createSnapshot("entry-1", makeCtx().ctx);

        writeFile(tmpDir, "created-by-pi.txt", "pi made this");
        await store.createSnapshot("entry-2", makeCtx().ctx);

        await restoreToSnapshot(hash!, store.config, makeCtx().ctx);
        expect(exists(tmpDir, "created-by-pi.txt")).toBe(false);
        expect(readFile(tmpDir, "a.txt")).toBe("v1");
    });

    test("leaves untracked user files alone", async () => {
        const store = await makeStore(tmpDir);
        await store.ensureInitial(makeCtx().ctx);
        writeFile(tmpDir, "a.txt", "v1");
        const hash = await store.createSnapshot("entry-1", makeCtx().ctx);

        writeFile(tmpDir, "user-only.txt", "user file");
        await restoreToSnapshot(hash!, store.config, makeCtx().ctx);
        expect(readFile(tmpDir, "user-only.txt")).toBe("user file");
    });

    test("recreates deleted files", async () => {
        const store = await makeStore(tmpDir);
        await store.ensureInitial(makeCtx().ctx);
        writeFile(tmpDir, "a.txt", "v1");
        const hash = await store.createSnapshot("entry-1", makeCtx().ctx);

        fs.unlinkSync(path.join(tmpDir, "a.txt"));
        await store.createSnapshot("entry-2", makeCtx().ctx);

        await restoreToSnapshot(hash!, store.config, makeCtx().ctx);
        expect(readFile(tmpDir, "a.txt")).toBe("v1");
    });

    test("idempotent restore", async () => {
        const store = await makeStore(tmpDir);
        await store.ensureInitial(makeCtx().ctx);
        writeFile(tmpDir, "a.txt", "v1");
        const hash = await store.createSnapshot("entry-1", makeCtx().ctx);

        writeFile(tmpDir, "a.txt", "v2");
        await restoreToSnapshot(hash!, store.config, makeCtx().ctx);
        await restoreToSnapshot(hash!, store.config, makeCtx().ctx);
        expect(readFile(tmpDir, "a.txt")).toBe("v1");
    });
});

// ============================================================================
// End-to-end /tree rollback
// ============================================================================

describe("/tree rollback end-to-end", () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-rollback-e2e-"));
        await initSourceRepo(tmpDir);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("rolling back with no pi changes does NOT delete user files", async () => {
        const store = await makeStore(tmpDir);
        writeFile(tmpDir, "user-a.txt", "a");
        writeFile(tmpDir, "user-b.txt", "b");
        writeFile(tmpDir, "docs/notes.md", "notes");

        // Lazy initial baseline captures pre-session user files so deep
        // rollback preserves them.
        await store.ensureInitial(makeCtx().ctx);

        const hash = await store.createSnapshot("turn1-leaf", makeCtx().ctx);
        expect(hash).toBeUndefined();
        expect(store.getAll().size).toBe(0);

        const snapshot = await store.findSnapshot("any-earlier-leaf", makeCtx().ctx);
        expect(snapshot).toBe(store.getInitialStateCommit());

        expect(exists(tmpDir, "user-a.txt")).toBe(true);
        expect(exists(tmpDir, "user-b.txt")).toBe(true);
        expect(readFile(tmpDir, "docs/notes.md")).toBe("notes");
    });

    test("rolling back a newly created file works and rolling forward recreates it", async () => {
        const store = await makeStore(tmpDir);
        await store.ensureInitial(makeCtx().ctx);
        writeFile(tmpDir, "created.txt", "pi made this");
        const creationHash = await store.createSnapshot("turn1-leaf", makeCtx().ctx);
        expect(creationHash).toBeDefined();

        const beforeHash = await store.findSnapshot("before-turn1", makeCtx().ctx);
        expect(beforeHash).toBeDefined();
        expect(beforeHash).not.toBe(creationHash);

        await restoreToSnapshot(beforeHash!, store.config, makeCtx().ctx);
        expect(exists(tmpDir, "created.txt")).toBe(false);

        await restoreToSnapshot(creationHash!, store.config, makeCtx().ctx);
        expect(exists(tmpDir, "created.txt")).toBe(true);
        expect(readFile(tmpDir, "created.txt")).toBe("pi made this");
    });

    test("deep rollback to initial restores pre-session state without wiping user files", async () => {
        writeFile(tmpDir, "existing.txt", "original");
        await runGit(tmpDir, ["add", "existing.txt"]);
        await runGit(tmpDir, ["commit", "-m", "init"]);

        const store = await makeStore(tmpDir);
        await store.ensureInitial(makeCtx().ctx);
        writeFile(tmpDir, "new.txt", "created by pi");
        await store.createSnapshot("turn1-leaf", makeCtx().ctx);

        const initial = await store.findSnapshot("before-pi", makeCtx().ctx);
        expect(initial).toBe(store.getInitialStateCommit());

        await restoreToSnapshot(initial!, store.config, makeCtx().ctx);
        expect(exists(tmpDir, "new.txt")).toBe(false);
        expect(readFile(tmpDir, "existing.txt")).toBe("original");
    });
});
