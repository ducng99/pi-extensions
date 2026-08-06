/**
 * Serializes MCP callTool results into pi tool-result text.
 */

interface McpContentBlock {
    type?: string;
    text?: string;
    data?: string;
    mimeType?: string;
    resource?: { uri?: string; text?: string; blob?: string } | unknown;
    [key: string]: unknown;
}

interface McpCallToolResult {
    content?: McpContentBlock[];
    isError?: boolean;
    structuredContent?: unknown;
    _meta?: unknown;
    [key: string]: unknown;
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2);
    }
    catch {
        return String(value);
    }
}

function resourceText(resource: unknown): string | undefined {
    if (resource && typeof resource === "object") {
        const r = resource as { uri?: string; text?: string; blob?: string };
        if (typeof r.text === "string") return r.text;
        if (typeof r.blob === "string") return `[resource blob: ${r.uri ?? ""} (base64)]`;
        return r.uri ? `[resource: ${r.uri}]` : undefined;
    }
    return undefined;
}

function blockToString(block: McpContentBlock): string {
    switch (block.type) {
        case "text":
            return typeof block.text === "string" ? block.text : "";
        case "image": {
            const bytes = typeof block.data === "string" ? block.data.length : 0;
            return `[image: ${block.mimeType ?? "unknown"} (${bytes} base64 chars)]`;
        }
        case "audio":
            return `[audio: ${block.mimeType ?? "unknown"}]`;
        case "resource": {
            const text = resourceText(block.resource);
            return text ?? `[resource: ${JSON.stringify(block.resource ?? "")}]`;
        }
        case "embedded":
            return `[embedded resource]\n${safeJson(block.resource)}`;
        default:
            return safeJson(block);
    }
}

/** Format an MCP tool result for pi. */
export function formatToolResult(result: McpCallToolResult): { text: string; details: Record<string, unknown> } {
    const parts: string[] = [];
    if (Array.isArray(result.content)) {
        for (const block of result.content) parts.push(blockToString(block));
    }
    if (result.structuredContent !== undefined) {
        parts.push(`Structured output:\n${safeJson(result.structuredContent)}`);
    }
    const text = parts.filter(Boolean).join("\n") || "(no content)";
    const details: Record<string, unknown> = { isError: result.isError === true };
    if (result._meta !== undefined) details._meta = result._meta;
    return { text, details };
}
