import { writeFile } from "fs/promises";
import { homedir } from "os";
import { isAbsolute, normalize, relative, resolve, sep } from "path";

import { parseBashCommand } from "../../shared/bash-parser/index";
import { matchPattern } from "../../shared/pattern-matching/index";
import { classifyBashCommand } from "./classifier";
import type { ParsedPermissions } from "./permission-parsing";
import type { ClassifierSessionContext } from "./session-context";
import { DEFAULT_ALLOWED_BASH_COMMANDS, DEFAULT_ALLOWED_TOOLS, TOOL_CATEGORY } from "./tool-categories";

const homeDir = homedir();
const LOG_PATH = normalize(`${homeDir}/pi/agent/tool-permission-bash.jsonl`);

async function appendLog(entry: Record<string, unknown>) {
    try {
        const line = JSON.stringify(entry);
        await writeFile(LOG_PATH, line + "\n", { flag: "a" });
    }
    catch { /* silently ignore log failures */ }
}

// ============================================================================
// Path utilities
// ============================================================================

/**
 * Resolve a directory path relative to cwd, expanding ~ to the home directory.
 */
function resolveDir(dir: string, cwd: string): string {
    if (dir === "~") {
        return normalize(homedir());
    }
    if (dir.startsWith("~/") || dir.startsWith("~\\")) {
        return normalize(resolve(homedir(), dir.slice(2)));
    }
    return normalize(resolve(cwd, dir));
}

/**
 * Resolve a command argument path relative to cwd, expanding ~ to home.
 */
function resolveArgPath(path: string, cwd: string): string {
    if (path === "~") {
        return normalize(homedir());
    }
    if (path.startsWith("~/") || path.startsWith("~\\")) {
        return normalize(resolve(homedir(), path.slice(2)));
    }
    return normalize(resolve(cwd, path));
}

/**
 * Check whether a resolved path is inside a given directory.
 *
 * Uses `path.relative` instead of raw prefix matching so it works with both
 * `/` and `\` separators (Windows) and compares case-insensitively on Windows
 * (e.g. `C:\Foo` vs `c:\foo`).
 */
function isInsideDir(resolvedPath: string, dir: string): boolean {
    const normalizedDir = normalize(resolve(dir));
    const rel = relative(normalizedDir, resolvedPath);
    // Equal paths (or case-variant equal on Windows) → inside.
    if (rel === "") return true;
    // Escaping the dir yields `..` or `..<sep>...`; on Windows, paths on
    // different drives yield an absolute relative path (e.g. `D:\...`).
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Check if a single path is outside the allowed boundary and all additional
 * directories.
 *
 * `resolveCwd` and `boundaryCwd` are deliberately distinct: `resolveCwd` is
 * only used to resolve *relative* path arguments (e.g. the effective cwd
 * after tracking `cd`s within a command chain), while `boundaryCwd` (and
 * `additionalDirs`) is the fixed set of directories the path must land
 * inside. Using the effective cwd as the boundary too would incorrectly flag
 * `cd ../..` as out-of-bounds when it merely returns to the original
 * (allowed) session cwd after having `cd`'d into a subdirectory.
 */
function isOutOfBoundsPath(path: string, resolveCwd: string, boundaryCwd: string, additionalDirs: string[]): boolean {
    const resolvedPath = resolveArgPath(path, resolveCwd);
    const resolvedBoundaryCwd = normalize(resolve(boundaryCwd));

    if (isInsideDir(resolvedPath, resolvedBoundaryCwd)) return false;

    for (const dir of additionalDirs) {
        if (isInsideDir(resolvedPath, resolveDir(dir, boundaryCwd))) return false;
    }

    return true;
}

// ============================================================================
// Argument String for Pattern Matching
// ============================================================================

function buildArgString(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
        case "edit":
        case "write":
        case "read": {
            const fp = input.path;
            return typeof fp === "string" ? fp : "";
        }
        case "bash": {
            const cmd = input.command;
            return typeof cmd === "string" ? cmd : "";
        }
        case "grep": {
            const pattern = input.pattern ?? "";
            const path = input.path ?? "";
            const glob = input.glob ?? "";
            const parts: string[] = [];
            if (typeof pattern === "string" && pattern) parts.push(pattern);
            if (typeof path === "string" && path) parts.push(path);
            if (typeof glob === "string" && glob) parts.push(glob);
            return parts.join(" ");
        }
        case "find": {
            // Represent as the equivalent bash command `find <path> <pattern>`
            // (path first, like `find / -name ...`), so rules such as
            // `Bash(find *)` and `Bash(find / *)` apply to the find tool too.
            const pattern = input.pattern ?? "";
            const path = input.path ?? "";
            const parts: string[] = ["find"];
            if (typeof path === "string" && path) parts.push(path);
            if (typeof pattern === "string" && pattern) parts.push(pattern);
            return parts.join(" ");
        }
        case "ls": {
            // Represent as the equivalent bash command `ls <path>`, so rules
            // such as `Bash(ls *)` apply to the ls tool too.
            const path = input.path ?? "";
            const suffix = typeof path === "string" && path ? ` ${path}` : "";
            return `ls${suffix}`;
        }
        case "webfetch": {
            const url = input.url;
            return typeof url === "string" ? url : "";
        }
        case "subagent": {
            // Return the name of the agent being triggered, so rules such as
            // `Agent(Explore)` (parsed to category "subagent" with pattern "Explore")
            // match against the invoked agent name.
            const agent = input.agent;
            return typeof agent === "string" ? agent : "";
        }
        default:
            return "";
    }
}

// ============================================================================
// Directory Bounds Check
// ============================================================================

/** Tools that operate on file paths */
const FILE_PATH_TOOLS = new Set(["edit", "write", "read"]);

/**
 * Check if the tool is accessing a file outside cwd and all additional directories.
 * Returns true if the access is out-of-bounds.
 */
export function isOutOfBounds(
    toolName: string,
    input: Record<string, unknown>,
    cwd: string,
    additionalDirs: string[],
): boolean {
    if (!FILE_PATH_TOOLS.has(toolName)) return false;

    const filePath = input.path as string;
    if (!filePath) return false;
    return isOutOfBoundsPath(filePath, cwd, cwd, additionalDirs);
}

// ============================================================================
// Permission Check
// ============================================================================

/**
 * The outcome of a permission check.
 *
 * `decision` is the action to take. When the decision is `"ask"`, an optional
 * `reason` may explain *why* it is being asked (e.g. the bash command was too
 * complex to analyze or failed to parse).
 */
export type PermissionDecision = { decision: "allow" | "ask" | "deny"; reason?: string };

/** Reason shown when a bash command could not be parsed by tree-sitter. */
export const REASON_BASH_PARSE_ERROR = "Unable to parse the command";
/** Reason shown when a bash command uses complex structures we don't analyze. */
export const REASON_BASH_COMPLEX = "Command uses complex structures";

/**
 * Builds the compact {@link ClassifierSessionContext} fed to the bash
 * classifier. Async because it may run `git status` once. The provider is
 * called lazily — only when a command actually reaches the classifier — so
 * non-bash tool calls and rule-resolved bash commands pay nothing.
 */
type SessionContextProvider = () => Promise<ClassifierSessionContext>;

export async function checkPermission(
    toolName: string,
    input: Record<string, unknown>,
    merged: ParsedPermissions,
    cwd: string = process.cwd(),
    isAutomodeOn?: () => boolean,
    signal?: AbortSignal,
    sessionContextProvider?: SessionContextProvider,
): Promise<PermissionDecision> {
    if (toolName === "bash") {
        return await checkBashPermission(input, merged, cwd, isAutomodeOn, signal, sessionContextProvider);
    }

    // MCP tools are addressed with the format `mcp__<server>__<tool>` (the same
    // format Claude Code uses for MCP permission rules), so rules declared in
    // claude settings apply here directly.
    if (isMcpTool(toolName)) {
        return checkMcpPermission(toolName, merged);
    }

    const category = TOOL_CATEGORY[toolName] ?? toolName;
    const argString = buildArgString(toolName, input);

    // 1. Deny — highest priority
    for (const rule of merged.deny) {
        if (rule.category === category && matchPattern(rule.pattern, argString)) {
            return { decision: "deny" };
        }
    }

    // 2. Ask
    for (const rule of merged.ask) {
        if (rule.category === category && matchPattern(rule.pattern, argString)) {
            return { decision: "ask" };
        }
    }

    // 3. Allow — only if the target path is in-bounds
    for (const rule of merged.allow) {
        if (rule.category === category && matchPattern(rule.pattern, argString)) {
            if (cwd && isOutOfBounds(toolName, input, cwd, merged.additionalDirectories ?? [])) {
                return { decision: "ask", reason: "⚠ Accessing outside allowed directories." };
            }
            return { decision: "allow" };
        }
    }

    // 4. Default allowed tools
    if (DEFAULT_ALLOWED_TOOLS.has(toolName)) {
        return { decision: "allow" };
    }

    // 5. Default: ask
    return { decision: "ask" };
}

// ============================================================================
// MCP Permission Check
// ============================================================================

/**
 * True if the tool name uses the MCP naming convention `mcp__<server>__<tool>`.
 */
export function isMcpTool(name: string): boolean {
    return name.startsWith("mcp__") && name.indexOf("__", "mcp__".length) !== -1;
}

/**
 * Return the server-scoped prefix of an MCP name, e.g. `mcp__github__create_issue`
 * → `mcp__github__`. For a bare server name (`mcp__github`) it appends the
 * trailing separator so it compares equal to a tool's prefix.
 */
function mcpServerPrefix(name: string): string {
    const idx = name.indexOf("__", "mcp__".length);
    if (idx === -1) return name + "__";
    return name.slice(0, idx + 2);
}

/**
 * Match an MCP permission spec (`mcp__server`, `mcp__server__tool`, or any
 * `*`-wildcard variant) against a concrete MCP tool name. The server segment
 * must match literally; only the tool segment may use wildcards.
 */
function mcpSpecMatches(spec: string, toolName: string): boolean {
    // Global wildcard matches any MCP tool.
    if (spec === "mcp__*") return true;
    if (!spec.startsWith("mcp__")) return false;

    const toolPrefix = mcpServerPrefix(toolName);

    // Bare server spec (e.g. `mcp__github`): matches every tool of that server.
    const specHasTool = spec.indexOf("__", "mcp__".length) !== -1;
    if (!specHasTool) {
        return spec + "__" === toolPrefix;
    }

    // Spec with a tool segment: server must match literally, tool may glob.
    const specServer = mcpServerPrefix(spec);
    if (specServer !== toolPrefix) return false;

    return matchPattern(spec.slice(specServer.length), toolName.slice(toolPrefix.length));
}

/**
 * Check whether an MCP tool call is permitted. MCP rules carry no path/arg
 * specifier in the pattern (Claude scopes them purely by tool name), so the
 * tool's name is matched, not an argument string.
 */
function checkMcpPermission(toolName: string, merged: ParsedPermissions): PermissionDecision {
    const matchesRule = (rule: { category: string; pattern: string }): boolean =>
        mcpSpecMatches(rule.category, toolName) && matchPattern(rule.pattern, "");

    for (const rule of merged.deny) {
        if (matchesRule(rule)) return { decision: "deny" };
    }
    for (const rule of merged.ask) {
        if (matchesRule(rule)) return { decision: "ask" };
    }
    for (const rule of merged.allow) {
        if (matchesRule(rule)) return { decision: "allow" };
    }

    return { decision: "ask" };
}

// ============================================================================
// Bash Permission Check
// ============================================================================

/**
 * Check bash command permissions.
 *
 * Flow for each parsed sub-command:
 *   1. Deny match    → deny tool call
 *   2. Ask match     → ask user
 *   3. Out-of-bounds → ask user
 *   4. Allow match   → resolved
 *   5. cd in-bounds  → resolved (auto-allow)
 *   6. Query classifier
 *   7. Otherwise     → ask user
 */
async function checkBashPermission(
    input: Record<string, unknown>,
    merged: ParsedPermissions,
    cwd: string,
    isAutomodeOn?: () => boolean,
    signal?: AbortSignal,
    sessionContextProvider?: SessionContextProvider,
): Promise<PermissionDecision> {
    const cmd = input.command;
    if (typeof cmd !== "string") return { decision: "ask" };

    const category = "bash";

    // 1. Parse with tree-sitter first.
    const parseResult = parseBashCommand(cmd);

    if (parseResult.kind === "error") {
        return { decision: "ask", reason: REASON_BASH_PARSE_ERROR };
    }

    const commands = parseResult.commands;
    if (commands.length === 0) {
        return { decision: "ask" };
    }

    // 1. Deny
    for (const leafCmd of commands) {
        for (const rule of merged.deny) {
            if (rule.category === category && matchPattern(rule.pattern, leafCmd.argString)) {
                return { decision: "deny" };
            }
        }
    }

    // 2. Ask
    for (const leafCmd of commands) {
        for (const rule of merged.ask) {
            if (rule.category === category && matchPattern(rule.pattern, leafCmd.argString)) {
                return { decision: "ask" };
            }
        }
    }

    // The session context snapshot is built once per command (lazily, on the
    // first leaf that reaches the classifier) and reused across all leaves in
    // this command — so a multi-leaf command issues a single `git status`.
    let sessionCtx: ClassifierSessionContext | undefined;
    let sessionCtxLoaded = false;
    const getSessionCtx = async (): Promise<ClassifierSessionContext | undefined> => {
        if (!sessionContextProvider) return undefined;
        if (!sessionCtxLoaded) {
            sessionCtx = await sessionContextProvider();
            sessionCtxLoaded = true;
        }
        return sessionCtx;
    };

    // 3. Out-of-bounds check + 4. Allow / cd auto-allow
    // Process commands in order so that `cd` changes the effective cwd for
    // subsequent relative paths. The *boundary* (`cwd`) stays fixed at the
    // original session cwd throughout — only the base used to resolve
    // relative paths (`effectiveCwd`) tracks `cd`s, so moving back up the
    // tree (e.g. `cd sub && ... && cd ../..`) is correctly recognized as
    // staying within bounds.
    let effectiveCwd = cwd;
    let shouldAllow: PermissionDecision = { decision: "allow" };

    for (const leafCmd of commands) {
        const additionalDirs = merged.additionalDirectories ?? [];

        // 3. Out-of-bounds check for this command using the effective cwd to
        // resolve relative paths, but the original session cwd as the bound.
        if (effectiveCwd && isCommandOutOfBounds(leafCmd.args, leafCmd.argString, effectiveCwd, cwd, additionalDirs)) {
            return { decision: "ask", reason: "⚠ Accessing outside allowed directories." };
        }

        // Complex leaves only get deny-rule checking (already done above); for
        // everything else, ask — or consult the classifier in automode.
        if (leafCmd.isComplex) {
            shouldAllow = { decision: "ask", reason: REASON_BASH_COMPLEX };
            break;
        }

        // 4a. `cd` auto-allow, and update the effective cwd for later commands.
        if (effectiveCwd) {
            const cdTarget = getCdTarget(leafCmd.args, effectiveCwd, cwd, additionalDirs);
            if (cdTarget) {
                effectiveCwd = cdTarget;
                continue;
            }
        }

        // 4b. Allow rule match.
        let allowMatched = false;
        for (const rule of merged.allow) {
            if (rule.category === category && matchPattern(rule.pattern, leafCmd.argString)) {
                allowMatched = true;
                break;
            }
        }
        if (allowMatched) continue;

        // 4c. Default allowed bash commands (safe, cannot read file contents).
        if (leafCmd.args.length > 0 && DEFAULT_ALLOWED_BASH_COMMANDS.has(leafCmd.args[0]!)) {
            continue;
        }

        shouldAllow = { decision: "ask" };
    }

    if (shouldAllow.decision === "ask") {
        // Log context + bash command for LLM training data
        const sessionCtx = await getSessionCtx();
        appendLog({
            command: cmd,
            cwd,
            gitRemote: sessionCtx?.gitRemote,
            gitStatus: sessionCtx?.gitStatus,
            recentToolCalls: sessionCtx?.recentToolCalls,
            agentTouchedFiles: sessionCtx?.agentTouchedFiles,
            lastUserPrompt: sessionCtx?.lastUserPrompt,
            category: "bash",
            reason: shouldAllow.reason,
        }).catch(() => {});
        if (isAutomodeOn?.()) {
            return await classifyBashCommand(cmd, signal, await getSessionCtx());
        }
        else {
            return { decision: "ask", reason: shouldAllow.reason };
        }
    }

    return { decision: "allow" };
}

// ============================================================================
// Bash `cd` Auto-Allow
// ============================================================================

/**
 * Extract and validate the target directory of a `cd <path>` command.
 * Returns the resolved path if the cd is in-bounds, otherwise null.
 */
function getCdTarget(args: string[], resolveCwd: string, boundaryCwd: string, additionalDirs: string[]): string | null {
    if (args.length < 1 || args[0] !== "cd") return null;

    let targetPath = "";
    for (let i = 1; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === "--") continue;
        if (!arg.startsWith("-")) {
            targetPath = arg;
            break;
        }
    }
    if (!targetPath) return null;

    if (isOutOfBoundsPath(targetPath, resolveCwd, boundaryCwd, additionalDirs)) return null;
    return resolveArgPath(targetPath, resolveCwd);
}

/**
 * Check if any path in a single command is outside the effective cwd and
 * additional directories.
 */
function isCommandOutOfBounds(
    args: string[],
    argString: string,
    resolveCwd: string,
    boundaryCwd: string,
    additionalDirs: string[],
): boolean {
    for (const path of extractPathArgs(args)) {
        // Skip /dev/null (POSIX) and NUL (Windows) null devices — they are
        // not real filesystem paths and should never trigger out-of-bounds.
        if (path === "/dev/null" || /^nul:?$/i.test(path)) continue;
        if (isOutOfBoundsPath(path, resolveCwd, boundaryCwd, additionalDirs)) return true;
    }
    for (const path of extractRedirectionPaths(argString)) {
        if (isOutOfBoundsPath(path, resolveCwd, boundaryCwd, additionalDirs)) return true;
    }
    return false;
}

// ============================================================================
// Bash Command Path Extraction
// ============================================================================

/**
 * Check if a token looks like a file path.
 */
function looksLikePath(token: string): boolean {
    // POSIX absolute and root-relative; Windows drive-relative (`\foo`).
    if (token.startsWith("/") || token.startsWith("\\")) return true;
    if (token.startsWith("~")) return true;
    // POSIX and Windows relative (`.\`, `..\`).
    if (token.startsWith("./") || token.startsWith(".\\")) return true;
    if (token.startsWith("../") || token.startsWith("..\\")) return true;
    if (token === "." || token === "..") return true;
    // Absolute Windows path with a drive letter, e.g. `C:\foo` or `C:/foo`.
    if (/^[a-zA-Z]:[\\/]/.test(token)) return true;
    if (token.includes("/") || token.includes("\\")) return true;
    return false;
}

/**
 * Strip matching outer quotes from a token.
 */
function stripQuotes(token: string): string {
    if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
        return token.slice(1, -1);
    }
    if (token.length >= 2 && token.startsWith("'") && token.endsWith("'")) {
        return token.slice(1, -1);
    }
    return token;
}

/**
 * Extract a path value from a token, handling `--key=/path` style arguments.
 */
function extractPathValue(token: string): string | null {
    const unquoted = stripQuotes(token);
    if (unquoted.startsWith("--") && unquoted.includes("=")) {
        const value = unquoted.slice(unquoted.indexOf("=") + 1);
        if (looksLikePath(value)) return value;
    }
    if (looksLikePath(unquoted)) return unquoted;
    return null;
}

/**
 * Commands whose first positional argument is a regex pattern (grep, rg) or a
 * sed script rather than a file path. Patterns can legitimately start with `/`
 * (e.g. `grep '/etc/passwd' file`), which would otherwise be mistaken for an
 * absolute path by the out-of-bounds check.
 */
const PATTERN_POSITION_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg", "sed"]);

/**
 * Long options that take a regex pattern/script as their value, per command.
 * Both `--opt value` and `--opt=value` forms are accepted.
 */
const PATTERN_LONG_OPTIONS: Record<string, Set<string>> = {
    grep: new Set(["--regexp"]),
    egrep: new Set(["--regexp"]),
    fgrep: new Set(["--regexp"]),
    rg: new Set(["--regexp"]),
    sed: new Set(["--expression"]),
};

/**
 * Long option that takes a *pattern file* as its value (e.g. `grep -f FILE`).
 * The value is a real file path and is still bounds-checked, but its presence
 * fills the positional pattern slot (so subsequent positionals are all files).
 */
const PATTERN_FILE_LONG_OPTIONS = new Set(["--file"]);

/**
 * Options that switch a pattern-based command into a mode with no pattern at
 * all (e.g. `rg --files`), so every positional argument is a path.
 */
const NO_PATTERN_OPTIONS: Record<string, Set<string>> = {
    rg: new Set(["--files", "--type-list"]),
};

/**
 * Classification of a single argument token of a pattern-based command.
 */
type PatternOptionKind
    = | { kind: "pattern"; value: string; separate: boolean }
        | { kind: "pattern-file"; value: string; separate: boolean }
        | { kind: "plain-option" }
        | { kind: "not-option" };

/**
 * Classify a single argument token of a pattern-based command (grep/rg/sed).
 *
 * `separate: true` means the value is the *next* argument (e.g. `-e PATTERN`),
 * `separate: false` means the value is attached to this token (e.g.
 * `-ePATTERN`, `--regexp=PATTERN`). Short-option bundles are scanned so that
 * `-rePATTERN` is recognized as `-r -e PATTERN`.
 */
function classifyPatternOption(command: string, token: string): PatternOptionKind {
    if (token === "-" || token === "--") return { kind: "not-option" };

    // Long options: `--regexp[=...]`, `--expression[=...]`, `--file[=...]`.
    if (token.startsWith("--")) {
        const eq = token.indexOf("=");
        const name = eq === -1 ? token : token.slice(0, eq);
        const value = eq === -1 ? "" : token.slice(eq + 1);

        if (PATTERN_LONG_OPTIONS[command]?.has(name)) {
            return { kind: "pattern", value, separate: eq === -1 };
        }
        if (PATTERN_FILE_LONG_OPTIONS.has(name)) {
            return { kind: "pattern-file", value, separate: eq === -1 };
        }
        return { kind: "plain-option" };
    }

    // Short options and bundles (e.g. `-e`, `-ePAT`, `-re`, `-rePAT`, `-fFILE`).
    if (token.startsWith("-") && token.length > 1) {
        for (let j = 1; j < token.length; j++) {
            const c = token[j]!;
            if (c === "e") {
                const attached = token.slice(j + 1);
                return { kind: "pattern", value: attached, separate: attached === "" };
            }
            if (c === "f") {
                const attached = token.slice(j + 1);
                return { kind: "pattern-file", value: attached, separate: attached === "" };
            }
            // `sed -i[SUFFIX]`: the rest of the token is an attached backup
            // suffix (e.g. `-i.bak`), not more options.
            if (command === "sed" && c === "i") {
                return { kind: "plain-option" };
            }
            // Other option characters take no value; keep scanning for a
            // bundled `-e`/`-f` (e.g. `-re`, `-rn`).
        }
        return { kind: "plain-option" };
    }

    return { kind: "not-option" };
}

/**
 * Extract file-path arguments from a single command's args, skipping regex
 * patterns and sed scripts for pattern-based commands (grep/rg/sed) so that a
 * pattern such as `/etc/passwd` is not mistaken for an absolute path.
 */
function extractPathArgs(args: string[]): string[] {
    if (args.length === 0) return [];

    const command = args[0]!;

    // In modes like `rg --files`, there is no pattern at all — every
    // positional argument is a path.
    const noPatternMode = NO_PATTERN_OPTIONS[command] !== undefined
        && args.slice(1).some(a => NO_PATTERN_OPTIONS[command]!.has(a));
    const patternFirst = !noPatternMode && PATTERN_POSITION_COMMANDS.has(command);

    const paths: string[] = [];
    // True once a pattern/script has been supplied (via `-e`/`--regexp`/
    // `--expression`/`-f`/`--file`, or via the positional slot itself). Once
    // true, every remaining positional argument is a real file path.
    let patternSupplied = false;
    let optionsEnded = false;

    for (let i = 1; i < args.length; i++) {
        const token = args[i]!;

        if (patternFirst) {
            if (token === "--") {
                optionsEnded = true;
                continue;
            }

            if (!optionsEnded) {
                const opt = classifyPatternOption(command, token);

                if (opt.kind === "plain-option") {
                    continue;
                }

                if (opt.kind === "pattern") {
                    patternSupplied = true;
                    if (opt.separate) {
                        i++; // skip the separate pattern value
                    }
                    continue;
                }

                if (opt.kind === "pattern-file") {
                    patternSupplied = true;
                    const value = opt.separate ? args[i + 1] : opt.value;
                    if (opt.separate && value !== undefined) {
                        i++; // consume the separate file value
                    }
                    if (value !== undefined) {
                        const path = extractPathValue(value);
                        if (path) paths.push(path);
                    }
                    continue;
                }

                // `not-option` → falls through to positional handling below.
            }
        }

        if (patternFirst && !patternSupplied) {
            // First positional of grep/rg/sed is the pattern/script, which may
            // look like an absolute path (`grep '/etc/passwd' file`).
            patternSupplied = true;
            continue;
        }

        const path = extractPathValue(token);
        if (path) {
            paths.push(path);
        }
    }

    return paths;
}

/**
 * Extract file paths from redirections in a raw command string.
 */
function extractRedirectionPaths(command: string): string[] {
    const paths: string[] = [];
    const redirectRegex = /(?:^|[^<])(\d*>>?|&>>?)\s*([^\s&|;<>]+)/g;
    let match: RegExpExecArray | null;

    while ((match = redirectRegex.exec(command)) !== null) {
        const operator = match[1]!;
        const filePath = match[2]!;

        // Skip heredoc (<<) and here string (<<<)
        if (operator.startsWith("<<")) continue;
        // Skip /dev/null (POSIX) and NUL (Windows) null devices
        if (filePath === "/dev/null") continue;
        if (/^nul:?$/i.test(filePath)) continue;
        // Skip file descriptors (e.g., 2>&1)
        if (/^&\d+$/.test(filePath)) continue;
        // Skip numeric-only targets (could be fd references)
        if (/^\d+$/.test(filePath)) continue;

        paths.push(filePath);
    }

    return paths;
}
