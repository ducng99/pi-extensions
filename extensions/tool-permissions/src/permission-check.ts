import { homedir } from "os";
import { isAbsolute, normalize, relative, resolve, sep } from "path";

import { parseBashCommand } from "../../shared/bash-parser/index";
import { matchPattern } from "../../shared/pattern-matching/index";
import { classifyBashCommand } from "./classifier";
import type { ParsedPermissions } from "./permission-parsing";
import type { ClassifierSessionContext } from "./session-context";
import { DEFAULT_ALLOWED_BASH_COMMANDS, DEFAULT_ALLOWED_TOOLS, TOOL_CATEGORY } from "./tool-categories";

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
 * Check if a single path is outside cwd and all additional directories.
 */
function isOutOfBoundsPath(path: string, cwd: string, additionalDirs: string[]): boolean {
    const resolvedPath = resolveArgPath(path, cwd);
    const resolvedCwd = normalize(resolve(cwd));

    if (isInsideDir(resolvedPath, resolvedCwd)) return false;

    for (const dir of additionalDirs) {
        if (isInsideDir(resolvedPath, resolveDir(dir, cwd))) return false;
    }

    return true;
}

// ============================================================================
// Argument String for Pattern Matching
// ============================================================================

function buildArgString(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
        case "edit":
        case "write": {
            const fp = input.file_path ?? input.path;
            return typeof fp === "string" ? fp : "";
        }
        case "read": {
            const fp = input.path ?? input.file_path;
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

/**
 * Extract the file path from a non-bash tool's input (if applicable).
 */
function extractFilePath(toolName: string, input: Record<string, unknown>): string | null {
    if (toolName === "edit" || toolName === "write") {
        const fp = input.file_path ?? input.path;
        return typeof fp === "string" ? fp : null;
    }
    if (toolName === "read") {
        const fp = input.path ?? input.file_path;
        return typeof fp === "string" ? fp : null;
    }
    return null;
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

    const filePath = extractFilePath(toolName, input);
    if (!filePath) return false;
    return isOutOfBoundsPath(filePath, cwd, additionalDirs);
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
export type PermissionDecision
    = | { decision: "deny" }
        | { decision: "allow"; reason?: string }
        | { decision: "ask"; reason?: string };

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
    // subsequent relative paths.
    let effectiveCwd = cwd;
    let shouldAllow: PermissionDecision = { decision: "allow" };

    for (const leafCmd of commands) {
        const additionalDirs = merged.additionalDirectories ?? [];

        // 3. Out-of-bounds check for this command using the effective cwd.
        if (effectiveCwd && isCommandOutOfBounds(leafCmd.args, leafCmd.argString, effectiveCwd, additionalDirs)) {
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
            const cdTarget = getCdTarget(leafCmd.args, effectiveCwd, additionalDirs);
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
function getCdTarget(args: string[], cwd: string, additionalDirs: string[]): string | null {
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

    if (isOutOfBoundsPath(targetPath, cwd, additionalDirs)) return null;
    return resolveArgPath(targetPath, cwd);
}

/**
 * Check if any path in a single command is outside the effective cwd and
 * additional directories.
 */
function isCommandOutOfBounds(
    args: string[],
    argString: string,
    cwd: string,
    additionalDirs: string[],
): boolean {
    for (const path of extractPathArgs(args)) {
        if (isOutOfBoundsPath(path, cwd, additionalDirs)) return true;
    }
    for (const path of extractRedirectionPaths(argString)) {
        if (isOutOfBoundsPath(path, cwd, additionalDirs)) return true;
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
 * Extract file-path arguments from a single command's args.
 */
function extractPathArgs(args: string[]): string[] {
    if (args.length === 0) return [];

    const paths: string[] = [];
    for (let i = 1; i < args.length; i++) {
        const token = args[i]!;
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
