/**
 * Build a compact string that identifies the *argument* of a tool call for
 * pattern matching (e.g. the file path for `edit`/`read`/`write`, the command
 * for `bash`, the URL for `webfetch`). Returns `""` for tools with no
 * meaningful argument (or unknown tools).
 *
 * Exported so the session allowlist in the extension entry point can key its
 * memoization on the same identifier that the permission rules use — meaning
 * "allow this for the session" matches exactly what an explicit allow rule
 * would have matched.
 */
export function buildArgString(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
        case "edit":
        case "write":
        case "patch":
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
