import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
    deriveSessionHash,
    findSourceRepo,
    getShadowDir,
    hashCwd,
    initShadowRepo,
    MAX_FILE_SIZE,
    seedShadowRepo,
    type ShadowGitConfig,
} from "../src/shadow-git";

function mockCtx() {
    return {
        ui: {
            notify: mock(() => {}),
        },
    } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;
}

function makeConfig(tmpDir: string, sessionKey = "test-session"): ShadowGitConfig {
    return {
        shadowDir: path.join(tmpDir, "shadow"),
        cwd: tmpDir,
        sessionKey,
    };
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

// ============================================================================
// hashCwd
// ============================================================================

describe("hashCwd", () => {
    test("is stable and normalizes slashes", () => {
        const h1 = hashCwd("/foo/bar");
        const h2 = hashCwd("/foo/bar");
        expect(h1).toBe(h2);
        expect(h1).toMatch(/^[0-9a-f]{40}$/);
    });

    test("normalizes backslashes", () => {
        expect(hashCwd("C:\\foo\\bar")).toBe(hashCwd("C:/foo/bar"));
    });
});

// ============================================================================
// deriveSessionHash
// ============================================================================

describe("deriveSessionHash", () => {
    test("uses session file basename without extension", () => {
        const hash = deriveSessionHash("/path/to/session-abc123.json", "sess-999");
        expect(hash).toBe("session-abc123");
    });

    test("uses ephemeral prefix for no session file", () => {
        const hash = deriveSessionHash(undefined, "ephemeral-id-42");
        expect(hash).toBe("ephemeral-ephemeral-id-42");
    });
});

// ============================================================================
// getShadowDir
// ============================================================================

describe("getShadowDir", () => {
    test("returns path under ~/.pi/agent/file-rollback/", () => {
        const dir = getShadowDir("test-session");
        expect(dir).toContain(".pi");
        expect(dir).toContain("file-rollback");
        expect(dir).toContain("test-session");
    });
});

// ============================================================================
// findSourceRepo
// ============================================================================

describe("findSourceRepo", () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-rollback-source-"));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("returns undefined outside a git repo", async () => {
        const source = await findSourceRepo(tmpDir);
        expect(source).toBeUndefined();
    });

    test("returns absolute git-common-dir inside a git repo", async () => {
        await initSourceRepo(tmpDir);
        const source = await findSourceRepo(tmpDir);
        expect(source).toBeDefined();
        expect(path.isAbsolute(source!)).toBe(true);
    });
});

// ============================================================================
// initShadowRepo
// ============================================================================

describe("initShadowRepo", () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-rollback-init-"));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("creates shadow repo directory and initializes git", async () => {
        const config = makeConfig(tmpDir);
        await initShadowRepo(config.shadowDir, config.cwd, mockCtx());
        expect(fs.existsSync(path.join(config.shadowDir, ".git"))).toBe(true);
    });

    test("is idempotent", async () => {
        const config = makeConfig(tmpDir);
        await initShadowRepo(config.shadowDir, config.cwd, mockCtx());
        await initShadowRepo(config.shadowDir, config.cwd, mockCtx());
        expect(fs.existsSync(path.join(config.shadowDir, ".git"))).toBe(true);
    });

    test("tunes config and has no HEAD commit", async () => {
        const config = makeConfig(tmpDir);
        await initShadowRepo(config.shadowDir, config.cwd, mockCtx());

        const autocrlf = await runGit(tmpDir, ["--git-dir", path.join(config.shadowDir, ".git"), "config", "core.autocrlf"]);
        expect(autocrlf.ok && autocrlf.stdout.trim()).toBe("false");

        const longpaths = await runGit(tmpDir, ["--git-dir", path.join(config.shadowDir, ".git"), "config", "core.longpaths"]);
        expect(longpaths.ok && longpaths.stdout.trim()).toBe("true");

        const fsmonitor = await runGit(tmpDir, ["--git-dir", path.join(config.shadowDir, ".git"), "config", "core.fsmonitor"]);
        expect(fsmonitor.ok && fsmonitor.stdout.trim()).toBe("false");

        const head = await runGit(tmpDir, ["--git-dir", path.join(config.shadowDir, ".git"), "rev-parse", "--verify", "HEAD"]);
        expect(head.ok).toBe(false);
    });
});

// ============================================================================
// seedShadowRepo
// ============================================================================

describe("seedShadowRepo", () => {
    let tmpDir: string;
    let sourceDir: string;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-rollback-seed-"));
        sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-rollback-seed-source-"));
        await initSourceRepo(sourceDir);
        writeFile(sourceDir, "tracked.txt", "source content");
        await runGit(sourceDir, ["add", "tracked.txt"]);
        await runGit(sourceDir, ["commit", "-m", "init"]);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(sourceDir, { recursive: true, force: true });
    });

    test("writes alternates file and copies source index", async () => {
        const config = makeConfig(tmpDir);
        await initShadowRepo(config.shadowDir, config.cwd, mockCtx());
        const source = await findSourceRepo(sourceDir);
        expect(source).toBeDefined();

        await seedShadowRepo(config.shadowDir, config.cwd, source!);

        const alternates = path.join(config.shadowDir, ".git", "objects", "info", "alternates");
        expect(fs.existsSync(alternates)).toBe(true);
        const contents = fs.readFileSync(alternates, "utf8");
        expect(contents).toContain(path.join(source!, "objects"));

        const shadowIndex = path.join(config.shadowDir, ".git", "index");
        expect(fs.existsSync(shadowIndex)).toBe(true);
    });
});

// ============================================================================
// MAX_FILE_SIZE
// ============================================================================

describe("MAX_FILE_SIZE", () => {
    test("equals 2 MB", () => {
        expect(MAX_FILE_SIZE).toBe(2 * 1024 * 1024);
    });
});
