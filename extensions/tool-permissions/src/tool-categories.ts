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
    webfetch: "webtools",
    websearch: "webtools",
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

// ============================================================================
// Default Allowed Bash Commands
// ============================================================================

/**
 * Bash commands that are allowed by default because they are read-only:
 * they cannot read/output file contents and have no side effects.
 * Users can still override these by adding explicit deny or ask rules.
 */
export const DEFAULT_ALLOWED_BASH_COMMANDS = new Set([
    // Core (note: cd has its own auto-allow logic with bounds checking)
    "pwd",
    "echo",
    "printf",
    "true",
    "false",
    "test",
    // Navigation / listing
    "ls",
    // Process / system info (read-only)
    "sleep",
    "date",
    "whoami",
    "hostname",
    "uname",
    "uptime",
    "id",
    // Command lookup (read-only)
    "type",
    "which",
    // Shell info (read-only)
    "time",
]);
