import { homedir } from "node:os";
import { normalize, resolve } from "node:path";

import { parseBashCommand } from "../../shared/bash-parser/index.js";
import { matchPattern } from "../../shared/pattern-matching/index.js";
import type { ParsedPermissions } from "./permission-parsing.js";
import { TOOL_CATEGORY } from "./tool-categories.js";

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
    if (dir.startsWith("~/")) {
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
    if (path.startsWith("~/")) {
        return normalize(resolve(homedir(), path.slice(2)));
    }
    return normalize(resolve(cwd, path));
}

/**
 * Check whether a resolved path is inside a given directory.
 */
function isInsideDir(resolvedPath: string, dir: string): boolean {
    const normalizedDir = normalize(resolve(dir));
    return resolvedPath === normalizedDir || resolvedPath.startsWith(normalizedDir + "/");
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
            const pattern = input.pattern ?? "";
            const path = input.path ?? "";
            const parts: string[] = [];
            if (typeof pattern === "string" && pattern) parts.push(pattern);
            if (typeof path === "string" && path) parts.push(path);
            return parts.join(" ");
        }
        case "ls": {
            const path = input.path ?? "";
            return typeof path === "string" ? path : "";
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
const FILE_PATH_TOOLS = new Set(["edit", "write", "read", "bash"]);

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

    // Bash: check all paths found in the command.
    if (toolName === "bash") {
        const cmd = input.command;
        if (typeof cmd !== "string") return false;
        for (const path of extractPathsFromBashCommand(cmd)) {
            if (isOutOfBoundsPath(path, cwd, additionalDirs)) return true;
        }
        return false;
    }

    // Non-bash: single file path.
    const filePath = extractFilePath(toolName, input);
    if (!filePath) return false;
    return isOutOfBoundsPath(filePath, cwd, additionalDirs);
}

// ============================================================================
// Permission Check
// ============================================================================

export function checkPermission(
    toolName: string,
    input: Record<string, unknown>,
    merged: ParsedPermissions,
    cwd?: string,
): "deny" | "ask" | "allow" {
    if (toolName === "bash") {
        return checkBashPermission(input, merged, cwd);
    }

    const category = TOOL_CATEGORY[toolName] ?? toolName;
    const argString = buildArgString(toolName, input);

    // 1. Deny — highest priority
    for (const rule of merged.deny) {
        if (rule.category === category && matchPattern(rule.pattern, argString)) {
            return "deny";
        }
    }

    // 2. Ask
    for (const rule of merged.ask) {
        if (rule.category === category && matchPattern(rule.pattern, argString)) {
            return "ask";
        }
    }

    // 3. Allow — only if the target path is in-bounds
    for (const rule of merged.allow) {
        if (rule.category === category && matchPattern(rule.pattern, argString)) {
            if (cwd && isOutOfBounds(toolName, input, cwd, merged.additionalDirectories ?? [])) {
                return "ask";
            }
            return "allow";
        }
    }

    // 4. Default: ask
    return "ask";
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
 *   6. Otherwise     → ask user
 */
function checkBashPermission(
    input: Record<string, unknown>,
    merged: ParsedPermissions,
    cwd?: string,
): "deny" | "ask" | "allow" {
    const cmd = input.command;
    if (typeof cmd !== "string") return "ask";

    const category = "bash";

    // 1. Parse with tree-sitter first.
    const parseResult = parseBashCommand(cmd);

    if (parseResult.kind === "error") {
        return "ask";
    }

    const commands = parseResult.commands;
    if (commands.length === 0) {
        return "ask";
    }

    // 1. Deny
    for (const leafCmd of commands) {
        for (const rule of merged.deny) {
            if (rule.category === category && matchPattern(rule.pattern, leafCmd.argString)) {
                return "deny";
            }
        }
    }

    // Complex commands only get deny-rule checking; everything else is "ask".
    if (parseResult.kind === "complex") {
        return "ask";
    }

    // 2. Ask
    for (const leafCmd of commands) {
        for (const rule of merged.ask) {
            if (rule.category === category && matchPattern(rule.pattern, leafCmd.argString)) {
                return "ask";
            }
        }
    }

    // 3. Out-of-bounds check + 4. Allow / cd auto-allow
    // Process commands in order so that `cd` changes the effective cwd for
    // subsequent relative paths.
    let effectiveCwd = cwd;
    for (const leafCmd of commands) {
        const additionalDirs = merged.additionalDirectories ?? [];

        // 3. Out-of-bounds check for this command using the effective cwd.
        if (effectiveCwd && isCommandOutOfBounds(leafCmd.args, leafCmd.argString, effectiveCwd, additionalDirs)) {
            return "ask";
        }

        // 4a. Allow rule match.
        let resolved = false;
        for (const rule of merged.allow) {
            if (rule.category === category && matchPattern(rule.pattern, leafCmd.argString)) {
                resolved = true;
                break;
            }
        }

        // 4b. `cd` auto-allow, and update the effective cwd for later commands.
        if (effectiveCwd) {
            const cdTarget = getCdTarget(leafCmd.args, effectiveCwd, additionalDirs);
            if (cdTarget) {
                resolved = true;
                effectiveCwd = cdTarget;
            }
        }

        if (!resolved) {
            return "ask";
        }
    }

    return "allow";
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
    if (token.startsWith("/")) return true;
    if (token.startsWith("~")) return true;
    if (token.startsWith("./")) return true;
    if (token.startsWith("../")) return true;
    if (token === "." || token === "..") return true;
    if (token.includes("/")) return true;
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
        // Skip /dev/null and similar
        if (filePath === "/dev/null") continue;
        // Skip file descriptors (e.g., 2>&1)
        if (/^&\d+$/.test(filePath)) continue;
        // Skip numeric-only targets (could be fd references)
        if (/^\d+$/.test(filePath)) continue;

        paths.push(filePath);
    }

    return paths;
}

/**
 * Extract all file paths from a bash command string.
 * Includes argument paths and redirection target paths.
 */
function extractPathsFromBashCommand(command: string): string[] {
    const parseResult = parseBashCommand(command);
    const paths: string[] = [];

    if (parseResult.kind !== "error") {
        for (const leafCmd of parseResult.commands) {
            paths.push(...extractPathArgs(leafCmd.args));
        }
    }

    paths.push(...extractRedirectionPaths(command));

    return paths;
}
