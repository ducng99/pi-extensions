import type { Theme } from "@earendil-works/pi-coding-agent";

export function formatConfirmMessage(theme: Theme, toolName: string, input: Record<string, unknown>, cwd: string, reason?: string): string {
    const lines: string[] = [];

    switch (toolName) {
        case "edit":
        case "write": {
            const fp = input.file_path ?? input.path;
            if (typeof fp === "string") {
                lines.push(`Edit file: ${fp}`);
            }
            break;
        }
        case "read": {
            const fp = input.path ?? input.file_path;
            if (typeof fp === "string") {
                lines.push(`Read file: ${fp}`);
            }
            break;
        }
        case "bash": {
            const command = input.command;
            if (typeof command === "string") {
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
        case "webfetch":
        case "WebFetch": {
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
        case "websearch":
        case "WebSearch": {
            const query = input.query;
            if (typeof query === "string") {
                lines.push(`Query: ${query}`);
            }
            break;
        }
        default:
            lines.push(`Tool: ${toolName}`);
    }

    if (reason?.trim()) {
        lines.push(theme.fg("muted", reason.trim()));
    }

    return lines.join("\n");
}
