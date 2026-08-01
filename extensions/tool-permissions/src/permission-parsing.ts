import { stripJsoncComments } from "../../shared/jsonc-utils/index.js";

// ============================================================================
// Config Parsing
// ============================================================================

export interface PermissionRule {
    category: string;
    pattern: string;
    decision: "allow" | "ask" | "deny";
}

export interface ParsedPermissions {
    allow: PermissionRule[];
    ask: PermissionRule[];
    deny: PermissionRule[];
    additionalDirectories?: string[];
}

function normalizePattern(pattern: string): string {
    return pattern;
}

function parseClaudePermissionString(entry: string): { tool: string | null; pattern: string } {
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

    // Normalize to lowercase for case-insensitive matching
    return { tool: tool.toLowerCase(), pattern };
}

export function parseOpencodePerms(content: string): ParsedPermissions {
    const result: ParsedPermissions = { allow: [], ask: [], deny: [] };
    let config: Record<string, unknown>;
    try {
        config = JSON.parse(stripJsoncComments(content));
    }
    catch {
        return result;
    }

    const perms = config?.permission;
    if (!perms || typeof perms !== "object") return result;

    // Extract external_directory entries as additionalDirectories
    const externalDir = perms.external_directory;
    if (typeof externalDir === "object" && externalDir !== null) {
        const dirs: string[] = [];
        for (const [pattern, decision] of Object.entries(externalDir as Record<string, unknown>)) {
            if (String(decision).toLowerCase() !== "allow") continue;
            // Extract base path from glob pattern (e.g., "~/projects/**" -> "~/projects")
            let dir = pattern;
            if (dir.endsWith("/**")) {
                dir = dir.slice(0, -3);
            }
            else if (dir.endsWith("/*")) {
                dir = dir.slice(0, -2);
            }
            dirs.push(dir);
        }
        if (dirs.length > 0) {
            result.additionalDirectories = dirs;
        }
    }

    for (const [toolKey, patterns] of Object.entries(perms)) {
        // Skip external_directory as it's handled above
        if (toolKey === "external_directory") continue;
        if (typeof patterns !== "object" || patterns === null) continue;
        const category = toolKey;

        for (const [pattern, decision] of Object.entries(patterns)) {
            const dec = String(decision).toLowerCase();
            if (dec !== "allow" && dec !== "ask" && dec !== "deny") continue;
            result[dec].push({ category, pattern: normalizePattern(pattern), decision: dec });
        }
    }

    return result;
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

    // Extract additionalDirectories (inside permissions object)
    const additionalDirs = perms.additionalDirectories;
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
                decision,
            });
        }
    }

    return result;
}
