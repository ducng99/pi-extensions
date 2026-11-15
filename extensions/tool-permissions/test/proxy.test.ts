import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "bun:test";

import { parseProxyResponse, slimEntries } from "../src/proxy";

describe("slimEntries", () => {
    test("keeps user messages and assistant tool calls, drops results and prose", () => {
        const entries = [
            { type: "message", message: { role: "user", content: "do it" } },
            { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "toolCall", name: "bash", arguments: { command: "ls" } }] } },
            { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "big output" }] } },
            { type: "custom", customType: "x" },
            { type: "compaction" },
        ] as unknown as SessionEntry[];

        expect(slimEntries(entries)).toEqual([
            { type: "message", message: { role: "user", content: "do it" } },
            { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }] } },
            { type: "compaction" },
        ] as unknown as SessionEntry[]);
    });
});

describe("parseProxyResponse", () => {
    test("allows when block is false", () => {
        expect(parseProxyResponse(JSON.stringify({ block: false }))).toEqual({ block: false, reason: undefined, terminate: undefined });
    });

    test("passes through block reason and terminate", () => {
        expect(parseProxyResponse(JSON.stringify({ block: true, reason: "no", terminate: true }))).toEqual({ block: true, reason: "no", terminate: true });
    });

    test("cancelled request is denied and terminates", () => {
        expect(parseProxyResponse(undefined).block).toBe(true);
        expect(parseProxyResponse(undefined).terminate).toBe(true);
    });

    test("malformed response is denied", () => {
        expect(parseProxyResponse("not json").block).toBe(true);
        expect(parseProxyResponse("{}").block).toBe(true);
    });
});
