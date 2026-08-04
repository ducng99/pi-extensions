/**
 * Shadow Git Repository
 *
 * Git primitives and repo management for the file-rollback extension.
 * Mirrors opencode's snapshot git layer: a shadow repo with a tree-hash-based
 * snapshot store, no commits, project-keyed storage, and source-repo object
 * alternates for large repos.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
export const PRUNE = "7.days";

/** Per-shadow-dir mutex to serialize concurrent git operations. */
const repoLocks = new Map<string, Promise<unknown>>();

export interface ShadowGitConfig {
    shadowDir: string;
    cwd: string;
    sessionKey: string;
    source?: string;
}

export type GitResult = {
    ok: true;
    stdout: string;
    stderr: string;
    exitCode: number;
} | {
    ok: false;
    stdout: string;
    stderr: string;
    exitCode: number;
};

function normalizeCwd(cwd: string): string {
    return cwd.replace(/\\/g, "/");
}

/**
 * SHA1 of the slash-normalized cwd. Used to key the shadow repo per project.
 */
export function hashCwd(cwd: string): string {
    const hash = createHash("sha1");
    hash.update(normalizeCwd(cwd));
    return hash.digest("hex");
}

/**
 * Derive a stable session hash for the sidecar persistence file.
 * For persistent sessions, hash the session file path.
 * For ephemeral sessions, use the session ID.
 */
export function deriveSessionHash(sessionFile: string | undefined, sessionId: string): string {
    if (sessionFile) {
        return path.basename(sessionFile).replace(/\.json$/i, "");
    }
    return `ephemeral-${sessionId}`;
}

/**
 * Get the shadow repo directory for a project cwd hash.
 */
export function getShadowDir(cwdHash: string): string {
    return path.join(os.homedir(), ".pi", "agent", "file-rollback", cwdHash);
}

/**
 * Low-level git spawn primitive.
 */
export function runGit(
    args: string[],
    options: {
        cwd?: string;
        env?: Record<string, string>;
        stdin?: string;
        ctx?: ExtensionContext;
    } = {},
): Promise<GitResult> {
    return new Promise((resolve) => {
        const cmd = "git";
        const proc = spawn(cmd, args, {
            cwd: options.cwd,
            env: options.env ? { ...process.env, ...options.env } : process.env,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });

        let stdout = "";
        let stderr = "";

        if (options.stdin) {
            proc.stdin.write(options.stdin, "utf8", (err) => {
                if (err) {
                    // Ignore; proc will error below.
                }
                proc.stdin.end();
            });
        }
        else {
            proc.stdin.end();
        }

        proc.stdout.on("data", (data: Buffer) => {
            stdout += data.toString("utf8");
        });

        proc.stderr.on("data", (data: Buffer) => {
            stderr += data.toString("utf8");
        });

        proc.on("close", (code) => {
            const exitCode = code ?? 1;
            if (exitCode === 0) {
                resolve({ ok: true, stdout, stderr, exitCode });
            }
            else {
                resolve({ ok: false, stdout, stderr: stderr.trim() || stdout.trim(), exitCode });
            }
        });

        proc.on("error", (err) => {
            const message = err instanceof Error ? err.message : String(err);
            options.ctx?.ui.notify(`git command failed: ${message}`, "warning");
            resolve({ ok: false, stdout: "", stderr: message, exitCode: 1 });
        });
    });
}

const cfg = ["-c", "core.autocrlf=false", "-c", "core.longpaths=true", "-c", "core.symlinks=true"];
const quote = [...cfg, "-c", "core.quotepath=false"];

/**
 * Run a git command in the shadow repo.
 */
export function gitShadow(
    shadowDir: string,
    cwd: string,
    args: string[],
    ctx?: ExtensionContext,
    stdin?: string,
): Promise<GitResult> {
    return runGit(
        [...quote, "--git-dir", path.join(shadowDir, ".git"), "--work-tree", cwd, ...args],
        { cwd, ctx, stdin },
    );
}

/**
 * Run a plain git command in the source repo.
 */
export function gitSource(
    cwd: string,
    args: string[],
    ctx?: ExtensionContext,
    stdin?: string,
): Promise<GitResult> {
    return runGit([...quote, ...args], { cwd, ctx, stdin });
}

/**
 * Find the absolute git-common-dir for the cwd, or undefined if not a git repo.
 */
export async function findSourceRepo(cwd: string): Promise<string | undefined> {
    const result = await gitSource(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!result.ok || !result.stdout.trim()) return undefined;
    const commonDir = result.stdout.trim();
    if (!commonDir || !fs.existsSync(commonDir)) return undefined;
    return commonDir;
}

/**
 * Initialize the shadow git repo if it doesn't exist.
 * No user.name, no init commit, no HEAD.
 */
export async function initShadowRepo(
    shadowDir: string,
    cwd: string,
    ctx?: ExtensionContext,
): Promise<void> {
    const gitDir = path.join(shadowDir, ".git");
    if (fs.existsSync(gitDir)) return;

    fs.mkdirSync(shadowDir, { recursive: true });

    const initResult = await gitShadow(shadowDir, cwd, ["init"], ctx);
    if (!initResult.ok) {
        ctx?.ui.notify("Failed to initialize file rollback shadow repo", "warning");
        return;
    }

    const configs: [string, string][] = [
        ["core.autocrlf", "false"],
        ["core.longpaths", "true"],
        ["core.symlinks", "true"],
        ["core.fsmonitor", "false"],
        ["feature.manyFiles", "true"],
        ["index.version", "4"],
        ["index.threads", "true"],
        ["core.untrackedCache", "true"],
    ];

    for (const [key, value] of configs) {
        const res = await gitShadow(shadowDir, cwd, ["config", key, value], ctx);
        if (!res.ok) {
            ctx?.ui.notify(`Failed to configure shadow git repo: ${key}`, "warning");
            return;
        }
    }
}

/**
 * Seed the shadow repo with the source repo's object database and index.
 */
export async function seedShadowRepo(
    shadowDir: string,
    cwd: string,
    source: string,
): Promise<void> {
    const sourceObjects = path.join(source, "objects");
    if (!fs.existsSync(sourceObjects)) return;

    const alternatesPath = path.join(shadowDir, ".git", "objects", "info", "alternates");
    fs.mkdirSync(path.dirname(alternatesPath), { recursive: true });

    const chained: string[] = [];
    const chainedFile = path.join(sourceObjects, "info", "alternates");
    if (fs.existsSync(chainedFile)) {
        const text = fs.readFileSync(chainedFile, "utf8");
        for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (trimmed && fs.existsSync(trimmed)) {
                chained.push(trimmed);
            }
        }
    }

    const alternates: string[] = [sourceObjects, ...chained].filter((item): item is string => Boolean(item));
    if (alternates.length === 0) return;

    fs.writeFileSync(alternatesPath, `${alternates.join("\n")}\n`, "utf8");

    const sourceIndex = path.join(source, "index");
    const targetIndex = path.join(shadowDir, ".git", "index");
    if (fs.existsSync(sourceIndex)) {
        try {
            fs.copyFileSync(sourceIndex, targetIndex);
        }
        catch {
            // Best-effort; fallback to full add.
        }
    }
}

/**
 * Serialize access to a shadow repo across concurrent sessions.
 */
export async function withRepoLock<A>(shadowDir: string, fn: () => Promise<A>): Promise<A> {
    const previous = repoLocks.get(shadowDir) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    repoLocks.set(shadowDir, next);
    return next;
}

/**
 * Get the file size in bytes.
 */
export async function getFileSize(filePath: string): Promise<number> {
    try {
        const stat = await fs.promises.stat(filePath);
        return stat.size;
    }
    catch {
        return 0;
    }
}
