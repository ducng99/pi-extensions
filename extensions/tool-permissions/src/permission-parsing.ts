// ============================================================================
// Config Parsing
// ============================================================================

export interface PermissionRule {
    category: string;
    pattern: string;
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

    // Web tools mapping
    if (tool === "WebFetch") {
        return { tool: "webfetch", pattern };
    }
    if (tool === "WebSearch") {
        return { tool: "websearch", pattern };
    }

    // Normalize to lowercase for case-insensitive matching
    return { tool: tool.toLowerCase(), pattern };
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
