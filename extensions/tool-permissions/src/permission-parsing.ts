// ============================================================================
// Config Parsing
// ============================================================================

import { homedir } from "os";
import { normalize, resolve } from "path";

export interface PermissionRule {
    category: string;
    pattern: string;
}

/**
 * Tool categories whose rule pattern is a file path (as opposed to a bash
 * command string, a URL, an agent name, ...). Only these get `~` expanded to
 * the home directory — bash patterns are matched against the raw command
 * text (`cat ~/x`), so expanding them would break matching.
 */
const FILE_PATH_PATTERN_TOOLS = new Set(["read", "edit", "find", "glob"]);

/**
 * Expand a leading `~` / `~/` in a rule pattern to the home directory.
 * Other patterns are returned unchanged.
 */
function expandTildeInPattern(pattern: string): string {
    if (pattern === "~") {
        return normalize(homedir());
    }
    if (pattern.startsWith("~/") || pattern.startsWith("~\\")) {
        return normalize(resolve(homedir(), pattern.slice(2)));
    }
    return pattern;
}

export interface ParsedPermissions {
    allow: PermissionRule[];
    ask: PermissionRule[];
    deny: PermissionRule[];
    additionalDirectories?: string[];
}

export function parseClaudePermissionString(entry: string): { tool: string | null; pattern: string } {
    // Format: "ToolName(pattern)" or just "ToolName"
    const parenIdx = entry.indexOf("(");
    if (parenIdx === -1) {
        // No parentheses — catch-all pattern
        return { tool: entry.toLowerCase(), pattern: "*" };
    }

    const tool = entry.slice(0, parenIdx);
    const pattern = entry.slice(parenIdx + 1, -1); // strip "(...)"

    // Special handling for Bash commands — they are "Bash(cmd)" which maps to category "bash"
    if (tool === "Bash") {
        return { tool: "bash", pattern };
    }

    // Edit and Write both merge into "edit"
    if (tool === "Edit" || tool === "Write") {
        return { tool: "edit", pattern };
    }

    // Glob maps to Pi's find tool (file search / globbing)
    if (tool === "Glob") {
        return { tool: "find", pattern };
    }

    if (tool === "Agent") {
        return { tool: "subagent", pattern };
    }

    // Web tools mapping
    if (tool === "WebFetch") {
        return { tool: "webfetch", pattern };
    }
    if (tool === "WebSearch") {
        return { tool: "websearch", pattern };
    }

    // Normalize to lowercase for case-insensitive matching
    const normalizedTool = tool.toLowerCase();
    const normalizedPattern = FILE_PATH_PATTERN_TOOLS.has(normalizedTool)
        ? expandTildeInPattern(pattern)
        : pattern;
    return { tool: normalizedTool, pattern: normalizedPattern };
}

export function parseClaudePerms(content: string): ParsedPermissions {
    const result: ParsedPermissions = { allow: [], ask: [], deny: [] };
    let config: Record<string, unknown>;
    try {
        config = JSON.parse(content);
    }
    catch {
        return result;
    }

    const perms = config?.permissions;
    if (!perms || typeof perms !== "object") return result;
    const typedPerms = perms as Record<string, unknown>;

    // Extract additionalDirectories (inside permissions object)
    const additionalDirs = typedPerms.additionalDirectories;
    if (Array.isArray(additionalDirs)) {
        result.additionalDirectories = additionalDirs
            .map((d: unknown) => typeof d === "string" ? d : null)
            .filter((d: string | null): d is string => d !== null);
    }

    for (const decision of ["allow", "ask", "deny"] as const) {
        if (!(decision in perms)) continue;
        const entries = (perms as Record<string, unknown>)[decision]!;
        if (!Array.isArray(entries)) continue;

        for (const entry of entries) {
            const str = String(entry);
            const { tool, pattern } = parseClaudePermissionString(str);
            if (!tool) continue;
            result[decision].push({
                category: tool,
                pattern,
            });
        }
    }

    return result;
}
