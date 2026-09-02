import { type Theme, truncateHead } from "@earendil-works/pi-coding-agent";

export function formatConfirmMessage(theme: Theme, toolName: string, input: Record<string, unknown>, cwd: string, reason?: string, hasUI?: boolean): string {
    const lines: string[] = [];

    switch (toolName) {
        case "edit":
        case "write":
        case "read": {
            const fp = input.path;
            if (typeof fp === "string") {
                const verb = toolName === "read" ? "Read" : "Edit";
                lines.push(`${verb} file: ${fp}`);
            }
            break;
        }
        case "bash": {
            let command = input.command;
            if (typeof command === "string") {
                if (hasUI === false) {
                    command = truncateHead(command, { maxLines: 10, maxBytes: 1000 });
                }
                lines.push(`Command: ${command}`);
            }
            break;
        }
        case "grep": {
            const pattern = input.pattern ?? "";
            const path = input.path ?? cwd;
            lines.push(`Grep: "${pattern}" in ${path}`);
            break;
        }
        case "find": {
            const pattern = input.pattern ?? "";
            const path = input.path ?? cwd;
            lines.push(`Find: "${pattern}" in ${path}`);
            break;
        }
        case "ls": {
            const path = input.path ?? cwd;
            lines.push(`List: ${path}`);
            break;
        }
        case "webfetch": {
            const url = input.url;
            const prompt = input.prompt;
            if (typeof url === "string") {
                lines.push(`URL: ${url}`);
            }
            if (typeof prompt === "string") {
                lines.push(`Prompt: ${prompt}`);
            }
            break;
        }
        case "websearch": {
            const query = input.query;
            if (typeof query === "string") {
                lines.push(`Query: ${query}`);
            }
            break;
        }
        default:
            // MCP tools use the `mcp__<server>__<tool>` naming convention
            if (toolName.startsWith("mcp__")) {
                const idx = toolName.indexOf("__", "mcp__".length);
                const server = idx === -1 ? toolName.slice("mcp__".length) : toolName.slice("mcp__".length, idx);
                const tool = idx === -1 ? "" : toolName.slice(idx + 2);
                lines.push(`MCP ${server}: ${tool}`);
            }
            else {
                lines.push(`Tool: ${toolName}`);
            }
    }

    if (reason?.trim()) {
        lines.push(theme.fg("muted", reason.trim()));
    }

    return lines.join("\n");
}
