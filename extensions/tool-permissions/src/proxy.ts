import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { PermissionProxyResponse } from "../../shared/permission-proxy/index";

/**
 * Reduce session entries to what the classifier reads: user messages, the
 * tool calls of assistant messages, and compaction markers. Tool results and
 * assistant prose are dropped so the request stays small.
 */
export function slimEntries(entries: SessionEntry[]): SessionEntry[] {
    const slim: unknown[] = [];
    for (const entry of entries) {
        if (entry.type === "compaction") {
            slim.push({ type: "compaction" });
            continue;
        }
        if (entry.type !== "message") continue;
        const message = entry.message as { role: string; content?: unknown };
        if (message.role === "user") {
            slim.push({ type: "message", message: { role: "user", content: message.content } });
        }
        else if (message.role === "assistant" && Array.isArray(message.content)) {
            const toolCalls = message.content.filter(block => block?.type === "toolCall");
            slim.push({ type: "message", message: { role: "assistant", content: toolCalls } });
        }
    }
    return slim as SessionEntry[];
}

/** Parse the parent's answer. Anything unexpected is a denial. */
export function parseProxyResponse(value: string | undefined): PermissionProxyResponse {
    if (value === undefined) {
        return { block: true, reason: "Permission request was cancelled.", terminate: true };
    }
    try {
        const parsed = JSON.parse(value) as Partial<PermissionProxyResponse>;
        if (typeof parsed.block !== "boolean") throw new Error("missing block");
        return { block: parsed.block, reason: parsed.reason, terminate: parsed.terminate };
    }
    catch {
        return { block: true, reason: "Invalid permission response from parent process.", terminate: true };
    }
}
