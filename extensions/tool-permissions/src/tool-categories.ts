// ============================================================================
// Tool → Permission Category Mapping
// ============================================================================

export const TOOL_CATEGORY: Record<string, string> = {
    edit: "edit",
    write: "edit",
    bash: "bash",
    read: "read",
    grep: "grep",
    find: "bash",
    ls: "bash",
    subagent: "subagent",
    ask_user_questions: "ask_user_questions",
};

// ============================================================================
// Default Allowed Tools
// ============================================================================

/**
 * Tools that are allowed by default when no explicit permission rule matches.
 * Users can still override these by adding explicit deny or ask rules.
 */
export const DEFAULT_ALLOWED_TOOLS = new Set([
    "ask_user_questions",
    "subagent",
]);
