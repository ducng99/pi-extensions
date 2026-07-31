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

  let tool = entry.slice(0, parenIdx);
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
  let config: any;
  try {
    config = JSON.parse(stripJsoncComments(content));
  } catch {
    return result;
  }

  const perms = config?.permission;
  if (!perms || typeof perms !== "object") return result;

  for (const [toolKey, patterns] of Object.entries(perms)) {
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
  let config: any;
  try {
    config = JSON.parse(content);
  } catch {
    return result;
  }

  // Extract additionalDirectories
  const additionalDirs = config?.additionalDirectories;
  if (Array.isArray(additionalDirs)) {
    result.additionalDirectories = additionalDirs
      .map((d: unknown) => typeof d === "string" ? d : null)
      .filter((d: string | null): d is string => d !== null);
  }

  const perms = config?.permissions;
  if (!perms || typeof perms !== "object") return result;

  for (const decision of ["allow", "ask", "deny"] as const) {
    const entries = perms[decision];
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
