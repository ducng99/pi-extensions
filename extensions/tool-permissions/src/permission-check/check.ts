import { basename, isAbsolute, normalize, relative, resolve, sep } from "path";

import { matchPattern } from "../../../shared/pattern-matching/index";
import { classifyToolCall } from "../classifier";
import type { ParsedPermissions } from "../permission-parsing";
import { DEFAULT_ALLOWED_TOOLS, TOOL_CATEGORY } from "../tool-categories";
import { buildArgString } from "./arg-string";
import { checkBashPermission } from "./bash-check";
import { FILE_PATH_TOOLS, getOutOfBoundsPath } from "./bounds";
import { checkMcpPermission, isMcpTool } from "./mcp";
import { resolveModeFallback } from "./mode-fallback";
import { isSensitivePath, resolveArgPath } from "./paths";
import type { PermissionDecision, PermissionMode, SessionContextProvider, SessionEntriesProvider } from "./types";

/**
 * Match a file-path rule pattern (read/edit/glob/patch categories) against a
 * tool call's path argument.
 *
 * Mirrors Claude Code semantics so rules written for Claude settings work:
 * - A pattern containing `/`, such as `Read(src/*)`, is additionally matched
 *   against the path relative to cwd.
 * - A bare filename pattern (no `/`), such as `Read(.env)` or
 *   `Read(.env*.local)`, matches the basename of the target file anywhere —
 *   `Read(.env)` must block `read ~/personal/crawler/.env`.
 */
function filePathRuleMatches(pattern: string, argString: string, cwd: string): boolean {
    if (matchPattern(pattern, argString)) return true;
    if (!argString) return false;

    for (const line of argString.split("\n")) {
        if (!pattern.includes("/")) {
            const base = basename(line.replace(/[\\/]+$/, ""));
            if (matchPattern(pattern, base)) return true;
        }

        // Also match the path relative to cwd, so cwd-local files like `.env`
        // resolve to the same relative path Claude rules are written against.
        const resolved = resolveArgPath(line, cwd);
        const rel = relative(normalize(resolve(cwd)), resolved);
        if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
            if (matchPattern(pattern, rel)) return true;
        }
    }
    return false;
}

/**
 * True if the rule category targets file paths (as opposed to bash commands,
 * URLs, agent names, ...).
 */
function isFilePathRuleCategory(category: string): boolean {
    return category === "read" || category === "edit" || category === "glob" || category === "patch";
}

export async function checkPermission(
    toolName: string,
    input: Record<string, unknown>,
    merged: ParsedPermissions,
    cwd: string = process.cwd(),
    getMode?: () => PermissionMode,
    signal?: AbortSignal,
    sessionContextProvider?: SessionContextProvider,
    sessionEntriesProvider?: SessionEntriesProvider,
    isSessionAllowed?: (path: string) => boolean,
): Promise<PermissionDecision> {
    if (toolName === "bash") {
        return await checkBashPermission(input, merged, cwd, getMode, signal, sessionContextProvider, sessionEntriesProvider, isSessionAllowed);
    }

    // read/edit/write on .pi/.claude is always asked — these files control
    // permissions and must never be modified silently.
    if (FILE_PATH_TOOLS.has(toolName)) {
        const filePath = input.path as string;
        if (typeof filePath === "string" && isSensitivePath(resolveArgPath(filePath, cwd), cwd)) {
            return { decision: "ask", reason: "⚠ Accessing sensitive files/directories." };
        }
    }

    // MCP tools are addressed with the format `mcp__<server>__<tool>` (the same
    // format Claude Code uses for MCP permission rules), so rules declared in
    // claude settings apply here directly.
    if (isMcpTool(toolName)) {
        const mcpDecision = checkMcpPermission(toolName, merged);
        // Explicit deny/ask rules take priority; only unresolved MCP calls
        // (no matching rule) fall through to the mode fallback in automode/allow mode.
        if (mcpDecision === null) {
            return await resolveModeFallback(toolName, input, getMode?.() ?? "off", signal, async () =>
                classifyToolCall(
                    toolName,
                    input,
                    signal,
                    sessionContextProvider ? await sessionContextProvider() : undefined,
                    sessionEntriesProvider?.(),
                    merged,
                ));
        }
        return mcpDecision;
    }

    const category = TOOL_CATEGORY[toolName] ?? toolName;
    const argString = buildArgString(toolName, input);

    const ruleMatches = (rule: { category: string; pattern: string }): boolean => {
        if (rule.category !== category) return false;
        if (isFilePathRuleCategory(category)) return filePathRuleMatches(rule.pattern, argString, cwd);
        return matchPattern(rule.pattern, argString);
    };

    // 1. Deny — highest priority
    for (const rule of merged.deny) {
        if (ruleMatches(rule)) return { decision: "deny" };
    }

    // 2. Ask
    for (const rule of merged.ask) {
        if (ruleMatches(rule)) return { decision: "ask" };
    }

    // 3. Allow — only if the target path is in-bounds
    for (const rule of merged.allow) {
        if (ruleMatches(rule)) {
            const outOfBoundsPath = cwd ? getOutOfBoundsPath(toolName, input, cwd, merged.additionalDirectories ?? []) : null;
            if (outOfBoundsPath && !isSessionAllowed?.(outOfBoundsPath)) {
                return {
                    decision: "ask",
                    reason: `⚠ Accessing outside allowed directories: ${outOfBoundsPath}`,
                    outOfBoundsPath,
                };
            }
            return { decision: "allow" };
        }
    }

    // 4. Default allowed tools
    if (DEFAULT_ALLOWED_TOOLS.has(toolName)) {
        return { decision: "allow" };
    }

    // 5. Mode fallback for unresolved tool calls in automode/allow mode.
    // Explicit deny/ask rules and out-of-bounds asks above have higher priority.
    const mode = getMode?.() ?? "off";
    if (mode !== "off") {
        return await resolveModeFallback(toolName, input, mode, signal, async () =>
            classifyToolCall(
                toolName,
                input,
                signal,
                sessionContextProvider ? await sessionContextProvider() : undefined,
                sessionEntriesProvider?.(),
                merged,
            ));
    }

    // 6. Default: ask
    return { decision: "ask" };
}
