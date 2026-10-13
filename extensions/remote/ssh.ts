import { type ChildProcess, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** A parsed SSH target: verbatim ssh destination plus an optional explicit port. */
export interface RemoteTarget {
    target: string;
    port?: number;
}

/** An active remote connection. */
export interface RemoteSession {
    target: string;
    port?: number;
    remoteCwd: string;
}

/** Result of a remote command. Buffers are kept binary-safe for file reads. */
export interface SshResult {
    stdout: Buffer;
    stderr: Buffer;
    code: number;
}

export interface SshExecOptions {
    timeout?: number;
    signal?: AbortSignal;
    /** Data written to the remote command's stdin. */
    input?: Buffer;
    /** Resolve instead of reject on non-zero exit codes. */
    allowNonZero?: boolean;
}

/** Tools available on the remote host, probed once per connection. */
export interface RemoteCapabilities {
    hasRg: boolean;
    hasFd: boolean;
}

export function remoteControlDir(): string {
    return join(homedir(), ".pi", "agent", "remote");
}

/** Parse `user@host`, an ssh-config alias, `host:port`, or `[v6]:port`. */
export function parseTarget(arg: string): RemoteTarget {
    const bracketed = arg.match(/^\[(.+)\]:(\d+)$/);
    if (bracketed) return { target: bracketed[1]!, port: Number(bracketed[2]) };
    const plain = arg.match(/^([^:]+):(\d+)$/);
    if (plain) return { target: plain[1]!, port: Number(plain[2]) };
    return { target: arg };
}

/** POSIX single-quote a string for safe embedding in a remote shell command. */
export function shQuote(s: string): string {
    return `'${s.replaceAll("'", "'\\''")}'`;
}

/**
 * Windows OpenSSH does not support ControlMaster multiplexing — using it fails
 * with "getsockname failed: Not a socket". There, every command opens its own
 * connection instead (slower, but fully functional with key auth).
 */
export function supportsControlMaster(): boolean {
    return process.platform !== "win32";
}

/** Base ssh options shared by every invocation (multiplexing when supported, timeouts, host-key policy). */
export function baseArgs(parsed: RemoteTarget): string[] {
    const args: string[] = [];
    if (supportsControlMaster()) {
        args.push(
            "-o", "ControlMaster=auto",
            "-o", `ControlPath=${join(remoteControlDir(), "cm-%C")}`,
            "-o", "ControlPersist=600",
        );
    }
    args.push(
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ServerAliveInterval=30",
    );
    if (parsed.port !== undefined) {
        args.push("-p", String(parsed.port));
    }
    return args;
}

/** Spawn an ssh client process running a (fully quoted) remote command. */
export function spawnSsh(session: RemoteSession, command: string): ChildProcess {
    return spawn("ssh", [...baseArgs(session), "--", session.target, command], { stdio: ["pipe", "pipe", "pipe"] });
}

/**
 * Execute a command on the remote host over the multiplexed connection.
 * The command runs in a remote POSIX shell; it must be fully quoted.
 */
export function sshExec(session: RemoteSession, command: string, options: SshExecOptions = {}): Promise<SshResult> {
    return new Promise((resolve, reject) => {
        const child = spawnSsh(session, command);
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;

        if (options.timeout !== undefined) {
            timer = setTimeout(() => {
                timedOut = true;
                child.kill();
            }, options.timeout * 1000);
        }

        const onAbort = () => child.kill();
        options.signal?.addEventListener("abort", onAbort, { once: true });

        child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));

        const cleanup = () => {
            if (timer) clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
        };

        child.on("error", (err) => {
            cleanup();
            reject(err);
        });

        child.on("close", (code) => {
            cleanup();
            if (options.signal?.aborted) {
                reject(new Error("Operation aborted"));
                return;
            }
            if (timedOut) {
                reject(new Error(`Remote command timed out after ${options.timeout}s`));
                return;
            }
            if (code !== 0 && !options.allowNonZero) {
                const errText = Buffer.concat(stderr).toString("utf-8").trim();
                reject(new Error(errText || `ssh exited with code ${code}`));
                return;
            }
            resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: code ?? 1 });
        });

        child.stdin!.end(options.input);
    });
}

/**
 * Verify connectivity and normalize the remote working directory. With no path,
 * the remote home directory (from `pwd`) is used.
 */
export async function connectRemote(targetArg: string, remotePath?: string): Promise<RemoteSession> {
    await mkdir(remoteControlDir(), { recursive: true });
    const parsed = parseTarget(targetArg);
    const command = remotePath === undefined
        ? "pwd"
        : `cd ${shQuote(remotePath)} && pwd`;
    const res = await sshExec({ target: parsed.target, port: parsed.port, remoteCwd: remotePath ?? "." }, command);
    return { target: parsed.target, port: parsed.port, remoteCwd: res.stdout.toString("utf-8").trim() };
}

/** Close the ControlMaster connection. Idempotent; errors are ignored. */
export function closeMaster(session: RemoteSession): void {
    if (!supportsControlMaster()) return; // No master exists on Windows.
    const child = spawn("ssh", [...baseArgs(session), "-O", "exit", session.target], { stdio: "ignore" });
    child.on("error", () => {});
}

export async function probeCapabilities(session: RemoteSession): Promise<RemoteCapabilities> {
    const res = await sshExec(session, "command -v rg; command -v fd", { allowNonZero: true, timeout: 15 });
    const paths = res.stdout.toString("utf-8").split("\n").map(l => l.trim());
    return {
        hasRg: paths.some(p => p.endsWith("/rg")),
        hasFd: paths.some(p => p.endsWith("/fd")),
    };
}

/**
 * Build an `ExecFn`-compatible function (same shape as `pi.exec`) that runs
 * commands on the remote host. Used by tool-permissions for its classifier
 * context (`git status` etc. must run on the remote).
 */
export function createRemoteExecFn(session: RemoteSession): (
    command: string,
    args: string[],
    options?: { cwd?: string; signal?: AbortSignal; timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
    return async (command, args, options) => {
        const cwdPrefix = options?.cwd ? `cd ${shQuote(options.cwd)} && ` : "";
        const remoteCommand = cwdPrefix + [command, ...args.map(shQuote)].join(" ");
        try {
            const res = await sshExec(session, remoteCommand, { signal: options?.signal, timeout: options?.timeout });
            return {
                stdout: res.stdout.toString("utf-8"),
                stderr: res.stderr.toString("utf-8"),
                code: res.code,
                killed: false,
            };
        }
        catch (err) {
            return {
                stdout: "",
                stderr: err instanceof Error ? err.message : String(err),
                code: 1,
                killed: true,
            };
        }
    };
}
