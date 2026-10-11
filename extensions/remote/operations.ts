import type { ChildProcess } from "node:child_process";
import { posix, resolve } from "node:path";
import { createInterface } from "node:readline";

import type {
    BashOperations,
    EditOperations,
    FindOperations,
    GrepToolDetails,
    LsToolDetails,
    ReadOperations,
    WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead, truncateLine } from "@earendil-works/pi-coding-agent";

import type { RemoteCapabilities, RemoteSession } from "./ssh";
import { spawnSsh } from "./ssh";
import { shQuote, sshExec } from "./ssh";

const GREP_DEFAULT_LIMIT = 100;
const GREP_MAX_LINE_LENGTH = 500;
const LS_DEFAULT_LIMIT = 500;
const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

export interface RemoteMatch {
    filePath: string;
    lineNumber: number;
    lineText?: string;
}

export interface RemoteToolResult<TDetails> {
    content: Array<{ type: "text"; text: string }>;
    details: TDetails | undefined;
}

/**
 * Translate an absolute local path to its remote counterpart. Paths inside the
 * local cwd are mapped under the remote cwd; anything else is passed through
 * unchanged (the out-of-bounds permission check flags those first).
 */
export function toRemotePath(localPath: string, localCwd: string, remoteCwd: string): string {
    const p = resolve(localCwd, localPath);
    const base = resolve(localCwd);
    if (p === base) return remoteCwd;
    if (p.startsWith(`${base}/`)) return remoteCwd + p.slice(base.length);
    return p;
}

export function createRemoteReadOperations(session: RemoteSession, localCwd: string): ReadOperations {
    const toRemote = (p: string) => toRemotePath(p, localCwd, session.remoteCwd);
    return {
        readFile: async (p) => {
            const res = await sshExec(session, `cat -- ${shQuote(toRemote(p))}`, { timeout: 120 });
            return res.stdout;
        },
        access: async (p) => {
            const res = await sshExec(session, `test -r ${shQuote(toRemote(p))}`, { allowNonZero: true, timeout: 15 });
            if (res.code !== 0) {
                throw new Error(`File is not readable: ${p}`);
            }
        },
        detectImageMimeType: async (p) => {
            try {
                const res = await sshExec(session, `file --mime-type -b -- ${shQuote(toRemote(p))}`, { allowNonZero: true, timeout: 15 });
                const mime = res.stdout.toString("utf-8").trim();
                return IMAGE_MIME_TYPES.includes(mime) ? mime : null;
            }
            catch {
                return null;
            }
        },
    };
}

export function createRemoteWriteOperations(session: RemoteSession, localCwd: string): WriteOperations {
    const toRemote = (p: string) => toRemotePath(p, localCwd, session.remoteCwd);
    return {
        writeFile: async (p, content) => {
            const b64 = Buffer.from(content, "utf-8").toString("base64");
            await sshExec(session, `base64 -d > ${shQuote(toRemote(p))}`, { input: Buffer.from(b64, "utf-8"), timeout: 120 });
        },
        mkdir: async (dir) => {
            await sshExec(session, `mkdir -p -- ${shQuote(toRemote(dir))}`, { timeout: 30 });
        },
    };
}

export function createRemoteEditOperations(session: RemoteSession, localCwd: string): EditOperations {
    const read = createRemoteReadOperations(session, localCwd);
    const write = createRemoteWriteOperations(session, localCwd);
    return { readFile: read.readFile, access: read.access, writeFile: write.writeFile };
}

export function createRemoteBashOperations(session: RemoteSession, localCwd: string): BashOperations {
    const toRemote = (p: string) => toRemotePath(p, localCwd, session.remoteCwd);
    return {
        exec: (command, cwd, options) => new Promise((resolveExec, rejectExec) => {
            if (options.signal?.aborted) {
                rejectExec(new Error("aborted"));
                return;
            }
            const remoteCommand = `cd ${shQuote(toRemote(cwd))} && ${command}`;
            const child = spawnSsh(session, remoteCommand);
            child.stdin?.end();
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

            child.stdout?.on("data", (chunk: Buffer) => options.onData(chunk));
            child.stderr?.on("data", (chunk: Buffer) => options.onData(chunk));

            const cleanup = () => {
                if (timer) clearTimeout(timer);
                options.signal?.removeEventListener("abort", onAbort);
            };

            child.on("error", (err) => {
                cleanup();
                rejectExec(err);
            });

            child.on("close", (code) => {
                cleanup();
                if (options.signal?.aborted) {
                    rejectExec(new Error("aborted"));
                    return;
                }
                if (timedOut) {
                    rejectExec(new Error(`timeout:${options.timeout}`));
                    return;
                }
                resolveExec({ exitCode: code ?? 1 });
            });
        }),
    };
}

/**
 * Custom `ls` execute: one remote `ls -1Ap` round trip (the tool's own ops
 * interface would stat every entry over SSH separately).
 */
export async function remoteLsExecute(
    session: RemoteSession,
    params: { path?: string; limit?: number },
    signal: AbortSignal | undefined,
    localCwd: string,
): Promise<RemoteToolResult<LsToolDetails>> {
    const dirPath = resolve(localCwd, params.path || ".");
    const remoteDir = toRemotePath(dirPath, localCwd, session.remoteCwd);
    const effectiveLimit = params.limit ?? LS_DEFAULT_LIMIT;

    const res = await sshExec(session, `ls -1Ap -- ${shQuote(remoteDir)}`, { signal, timeout: 30 });
    if (res.code !== 0) {
        const msg = res.stderr.toString("utf-8").trim() || `Path not found: ${dirPath}`;
        throw new Error(msg);
    }

    const entries = res.stdout.toString("utf-8")
        .split("\n")
        .filter(l => l.length > 0)
        .map(e => e.endsWith("/") ? { name: e.slice(0, -1), isDir: true } : { name: e, isDir: false });
    entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

    const results: string[] = [];
    let entryLimitReached = false;
    for (const entry of entries) {
        if (results.length >= effectiveLimit) {
            entryLimitReached = true;
            break;
        }
        results.push(entry.isDir ? `${entry.name}/` : entry.name);
    }

    if (results.length === 0) {
        return { content: [{ type: "text", text: "(empty directory)" }], details: undefined };
    }

    const truncation = truncateHead(results.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
    let output = truncation.content;
    const details: LsToolDetails = {};
    const notices: string[] = [];
    if (entryLimitReached) {
        notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
        details.entryLimitReached = effectiveLimit;
    }
    if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
    }
    if (notices.length > 0) {
        output += `\n\n[${notices.join(". ")}]`;
    }
    return { content: [{ type: "text", text: output }], details: Object.keys(details).length > 0 ? details : undefined };
}

/**
 * Custom `find` operations: `fd` on the remote when available, else a POSIX
 * `find` approximation. Results are returned relative to the search root so
 * the find tool's own relativization keeps working.
 */
export function createRemoteFindOperations(
    session: RemoteSession,
    capabilities: RemoteCapabilities,
    localCwd: string,
): FindOperations {
    const toRemote = (p: string) => toRemotePath(p, localCwd, session.remoteCwd);
    return {
        exists: async (p) => {
            const res = await sshExec(session, `test -e ${shQuote(toRemote(p))}`, { allowNonZero: true, timeout: 15 });
            return res.code === 0;
        },
        glob: async (pattern, searchPath, options) => {
            const remoteSearch = toRemote(searchPath);
            const ignoreNames = options.ignore
                .map(i => i.replace(/^\*\*\//, "").replace(/\/\*\*$/, ""))
                .filter(i => i.length > 0);

            let command: string;
            if (capabilities.hasFd) {
                const args = ["--glob", "--color=never", "--hidden", "--no-require-git", "--max-results", String(options.limit)];
                for (const name of ignoreNames) {
                    args.push("-E", name);
                }
                let effectivePattern = pattern;
                if (pattern.includes("/")) {
                    args.push("--full-path");
                    if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
                        effectivePattern = `**/${pattern}`;
                    }
                }
                args.push("--", effectivePattern, ".");
                command = `cd ${shQuote(remoteSearch)} && fd ${args.map(shQuote).join(" ")}`;
            }
            else {
                const excludes = ignoreNames.map(name => `-not -path ${shQuote(`*/${name}/*`)}`).join(" ");
                if (pattern.includes("/")) {
                    const converted = pattern.replace(/^\*\*\//, "").replaceAll("**", "*");
                    command = `cd ${shQuote(remoteSearch)} && find . -path ${shQuote(`*/${converted}`)} ${excludes} | head -n ${options.limit}`;
                }
                else {
                    command = `cd ${shQuote(remoteSearch)} && find . -name ${shQuote(pattern)} ${excludes} | head -n ${options.limit}`;
                }
            }

            const res = await sshExec(session, command, { timeout: 60 });
            return res.stdout.toString("utf-8")
                .split("\n")
                .map(l => l.replace(/^\.\//, "").trimEnd())
                .filter(l => l.length > 0);
        },
    };
}

interface RgEvent {
    type: string;
    data?: {
        path?: { text?: string };
        line_number?: number;
        lines?: { text?: string };
    };
}

async function collectMatchesFromStream(
    session: RemoteSession,
    command: string,
    parseRow: (line: string) => RemoteMatch | null,
    effectiveLimit: number,
    signal: AbortSignal | undefined,
): Promise<{ matches: RemoteMatch[]; matchLimitReached: boolean }> {
    return new Promise((resolveCollect, rejectCollect) => {
        const child: ChildProcess = spawnSsh(session, command);
        const rl = createInterface({ input: child.stdout! });
        const matches: RemoteMatch[] = [];
        let stderr = "";
        let matchLimitReached = false;
        let settled = false;

        const settle = (fn: () => void) => {
            if (settled) return;
            settled = true;
            fn();
        };
        const stopChild = () => {
            if (!child.killed) child.kill();
        };
        const onAbort = () => stopChild();
        signal?.addEventListener("abort", onAbort, { once: true });

        rl.on("line", (line) => {
            if (!line.trim() || matches.length >= effectiveLimit) return;
            const match = parseRow(line);
            if (!match) return;
            matches.push(match);
            if (matches.length >= effectiveLimit) {
                matchLimitReached = true;
                stopChild();
            }
        });

        child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        child.on("error", (err) => {
            rl.close();
            signal?.removeEventListener("abort", onAbort);
            settle(() => rejectCollect(err));
        });

        child.on("close", (code) => {
            rl.close();
            signal?.removeEventListener("abort", onAbort);
            if (signal?.aborted) {
                settle(() => rejectCollect(new Error("Operation aborted")));
                return;
            }
            if (!matchLimitReached && code !== 0 && code !== 1) {
                settle(() => rejectCollect(new Error(stderr.trim() || `remote search exited with code ${code}`)));
                return;
            }
            settle(() => resolveCollect({ matches, matchLimitReached }));
        });
    });
}

export function parseRgJsonRow(line: string): RemoteMatch | null {
    let event: RgEvent;
    try {
        event = JSON.parse(line);
    }
    catch {
        return null;
    }
    if (event.type !== "match") return null;
    const filePath = event.data?.path?.text;
    const lineNumber = event.data?.line_number;
    const lineText = event.data?.lines?.text;
    if (filePath && typeof lineNumber === "number") {
        return { filePath, lineNumber, lineText };
    }
    return null;
}

export function parseGrepRow(line: string): RemoteMatch | null {
    if (line === "--") return null;
    // Match rows use `path:line:text`; context rows (`path-line-text`) are
    // skipped — context is re-fetched from the file during formatting.
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) return null;
    return { filePath: m[1]!, lineNumber: Number(m[2]), lineText: m[3] };
}

/**
 * Format matches exactly like pi's built-in grep tool: `path:line: text` rows,
 * with `-C` context blocks fetched from the remote file.
 */
async function formatMatches(
    session: RemoteSession,
    matches: RemoteMatch[],
    isDirectory: boolean,
    searchPath: string,
    contextValue: number,
    signal: AbortSignal | undefined,
): Promise<{ outputLines: string[]; linesTruncated: boolean }> {
    const outputLines: string[] = [];
    let linesTruncated = false;

    const formatPath = (filePath: string): string => {
        if (isDirectory) {
            const rel = posix.relative(searchPath, filePath);
            if (rel && !rel.startsWith("..")) return rel;
        }
        return posix.basename(filePath);
    };

    const readLineRange = async (filePath: string, start: number, end: number): Promise<string[]> => {
        try {
            const res = await sshExec(session, `sed -n ${shQuote(`${start},${end}p`)} -- ${shQuote(filePath)}`, { signal, timeout: 30 });
            return res.stdout.toString("utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        }
        catch {
            return [];
        }
    };

    for (const match of matches) {
        const relPath = formatPath(match.filePath);
        if (contextValue === 0 && match.lineText !== undefined) {
            const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
            const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
            if (wasTruncated) linesTruncated = true;
            outputLines.push(`${relPath}:${match.lineNumber}: ${truncatedText}`);
        }
        else {
            const start = Math.max(1, match.lineNumber - contextValue);
            const end = match.lineNumber + contextValue;
            const lines = await readLineRange(match.filePath, start, end);
            if (lines.length === 0) {
                outputLines.push(`${relPath}:${match.lineNumber}: (unable to read file)`);
                continue;
            }
            for (let current = start; current <= end; current++) {
                const sanitized = (lines[current - start] ?? "").replace(/\r/g, "");
                const isMatchLine = current === match.lineNumber;
                const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
                if (wasTruncated) linesTruncated = true;
                if (isMatchLine) {
                    outputLines.push(`${relPath}:${current}: ${truncatedText}`);
                }
                else {
                    outputLines.push(`${relPath}-${current}- ${truncatedText}`);
                }
            }
        }
    }

    return { outputLines, linesTruncated };
}

/** Normalize a grep-fallback row path (`./sub/file`, relative to the search dir) to an absolute remote path. */
function normalizeFallbackPath(filePath: string, searchPath: string): string {
    const stripped = filePath.replace(/^\.\//, "");
    return posix.isAbsolute(stripped) ? stripped : posix.join(searchPath, stripped);
}

/**
 * Custom `grep` execute: `rg --json` on the remote when available, else GNU
 * grep. Output and details match pi's built-in grep tool.
 */
export async function remoteGrepExecute(
    session: RemoteSession,
    capabilities: RemoteCapabilities,
    params: {
        pattern: string;
        path?: string;
        glob?: string;
        ignoreCase?: boolean;
        literal?: boolean;
        context?: number;
        limit?: number;
    },
    signal: AbortSignal | undefined,
    localCwd: string,
): Promise<RemoteToolResult<GrepToolDetails>> {
    const searchLocal = resolve(localCwd, params.path || ".");
    const searchPath = toRemotePath(searchLocal, localCwd, session.remoteCwd);
    const effectiveLimit = Math.max(1, params.limit ?? GREP_DEFAULT_LIMIT);
    const contextValue = params.context && params.context > 0 ? params.context : 0;

    // Distinguish "missing" from "is a file" in a single round trip.
    const probe = await sshExec(
        session,
        `test -e ${shQuote(searchPath)}; e=$?; test -d ${shQuote(searchPath)}; d=$?; echo $e $d`,
        { allowNonZero: true, signal, timeout: 15 },
    );
    const codes = probe.stdout.toString("utf-8").trim().split(/\s+/).map(Number);
    if (codes[0] !== 0) {
        throw new Error(`Path not found: ${searchLocal}`);
    }
    const isDirectory = codes[1] === 0;

    let matches: RemoteMatch[];
    let matchLimitReached: boolean;

    if (capabilities.hasRg) {
        const args = ["--json", "--line-number", "--color=never", "--hidden"];
        if (params.ignoreCase) args.push("--ignore-case");
        if (params.literal) args.push("--fixed-strings");
        if (params.glob) args.push("--glob", params.glob);
        args.push("--", params.pattern, searchPath);
        const collected = await collectMatchesFromStream(
            session,
            `rg ${args.map(shQuote).join(" ")}`,
            (line) => {
                const match = parseRgJsonRow(line);
                return match ? { ...match, filePath: normalizeFallbackPath(match.filePath, searchPath) } : null;
            },
            effectiveLimit,
            signal,
        );
        matches = collected.matches;
        matchLimitReached = collected.matchLimitReached;
    }
    else {
        const args = ["-rnI", "--exclude-dir=.git", "--exclude-dir=node_modules"];
        if (params.ignoreCase) args.push("-i");
        args.push(params.literal ? "-F" : "-E");
        if (params.glob) args.push("--include", params.glob);
        args.push("-e", params.pattern, ".");
        const collected = await collectMatchesFromStream(
            session,
            `cd ${shQuote(searchPath)} && grep ${args.map(shQuote).join(" ")}`,
            (line) => {
                const match = parseGrepRow(line);
                return match ? { ...match, filePath: normalizeFallbackPath(match.filePath, searchPath) } : null;
            },
            effectiveLimit,
            signal,
        );
        matches = collected.matches;
        matchLimitReached = collected.matchLimitReached;
    }

    if (matches.length === 0) {
        return { content: [{ type: "text", text: "No matches found" }], details: undefined };
    }

    const { outputLines, linesTruncated } = await formatMatches(session, matches, isDirectory, searchPath, contextValue, signal);

    const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
    let output = truncation.content;
    const details: GrepToolDetails = {};
    const notices: string[] = [];
    if (matchLimitReached) {
        notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
        details.matchLimitReached = effectiveLimit;
    }
    if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
    }
    if (linesTruncated) {
        notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
        details.linesTruncated = true;
    }
    if (notices.length > 0) {
        output += `\n\n[${notices.join(". ")}]`;
    }
    return { content: [{ type: "text", text: output }], details: Object.keys(details).length > 0 ? details : undefined };
}
