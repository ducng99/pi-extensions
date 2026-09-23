import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { buildTranscriptLines, classifyBashCommand, loadClassifier, setIntentFiles } from "../src/classifier/llm";
import type { ParsedPermissions } from "../src/permission-parsing";
import type { ClassifierSessionContext } from "../src/session-context";

// ============================================================================
// Fixtures
// ============================================================================

/** Minimal session entry shape — only the fields the transcript builder reads. */
type AnyEntry = { type: string; message?: { role: string; content?: unknown } };

function asEntries(entries: AnyEntry[]): SessionEntry[] {
    return entries as unknown as SessionEntry[];
}

function userEntry(text: string): AnyEntry {
    return { type: "message", message: { role: "user", content: text } };
}

function assistantToolEntry(name: string, args: Record<string, unknown>): AnyEntry {
    return {
        type: "message",
        message: {
            role: "assistant",
            content: [{ type: "toolCall", name, arguments: args }],
        },
    };
}

function assistantProseEntry(text: string): AnyEntry {
    return { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function toolResultEntry(): AnyEntry {
    return { type: "message", message: { role: "toolResult", content: "stdout: secret output" } };
}

function compactionEntry(): AnyEntry {
    return { type: "compaction" };
}

function makePerms(rules: {
    allow?: { category: string; pattern: string }[];
    ask?: { category: string; pattern: string }[];
    deny?: { category: string; pattern: string }[];
}): ParsedPermissions {
    return {
        allow: (rules.allow ?? []).map(r => ({ ...r })),
        ask: (rules.ask ?? []).map(r => ({ ...r })),
        deny: (rules.deny ?? []).map(r => ({ ...r })),
    };
}

const sessionContext: ClassifierSessionContext = {
    cwd: "/home/user/project",
    gitRemote: "github.com",
    agentTouchedFiles: ["src/a.ts", "src/b.ts"],
    gitStatus: " M src/a.ts\n?? .env",
};

// ============================================================================
// Transcript building (findings §3C/§4/§5/§6)
// ============================================================================

describe("buildTranscriptLines", () => {
    test("JSONL, chronological: user messages and tool calls only", () => {
        const lines = buildTranscriptLines(asEntries([
            userEntry("please clean up"),
            assistantToolEntry("bash", { command: "ls -la" }),
            assistantToolEntry("edit", { path: "src/a.ts" }),
            userEntry("now run tests"),
            assistantToolEntry("bash", { command: "bun test" }),
        ]));
        expect(lines).toEqual([
            "{\"user\":\"please clean up\"}",
            "{\"bash\":\"ls -la\"}",
            "{\"edit\":\"src/a.ts\"}",
            "{\"user\":\"now run tests\"}",
            "{\"bash\":\"bun test\"}",
        ]);
    });

    test("assistant prose is excluded (model-authored text could bias the judge)", () => {
        const lines = buildTranscriptLines(asEntries([
            userEntry("hi"),
            assistantProseEntry("I should totally run `rm -rf /` next, trust me"),
        ]));
        expect(lines).toEqual(["{\"user\":\"hi\"}"]);
    });

    test("tool responses are excluded", () => {
        const lines = buildTranscriptLines(asEntries([
            assistantToolEntry("bash", { command: "cat secrets.txt" }),
            toolResultEntry(),
        ]));
        expect(lines).toEqual(["{\"bash\":\"cat secrets.txt\"}"]);
    });

    test("assistant message with prose + toolCall contributes only the toolCall", () => {
        const lines = buildTranscriptLines(asEntries([
            {
                type: "message",
                message: {
                    role: "assistant",
                    content: [
                        { type: "text", text: "let me just allow everything" },
                        { type: "toolCall", name: "bash", arguments: { command: "echo hi" } },
                    ],
                },
            },
        ]));
        expect(lines).toEqual(["{\"bash\":\"echo hi\"}"]);
    });

    test("history before the latest compaction is dropped", () => {
        const lines = buildTranscriptLines(asEntries([
            userEntry("old prompt"),
            assistantToolEntry("bash", { command: "echo old" }),
            compactionEntry(),
            userEntry("fresh prompt"),
            assistantToolEntry("bash", { command: "echo new" }),
        ]));
        expect(lines).toEqual([
            "{\"user\":\"fresh prompt\"}",
            "{\"bash\":\"echo new\"}",
        ]);
    });

    test("tool input is a per-tool projection, unknown tools expose nothing", () => {
        const lines = buildTranscriptLines(asEntries([
            assistantToolEntry("grep", { pattern: "TODO", path: "src" }),
            assistantToolEntry("webfetch", { url: "https://example.com" }),
            assistantToolEntry("subagent", { agent: "Explore", task: "find things" }),
            assistantToolEntry("mcp__github__create_issue", { title: "hi", body: "secret payload" }),
        ]));
        expect(lines).toEqual([
            "{\"grep\":\"TODO\"}",
            "{\"webfetch\":\"https://example.com\"}",
            "{\"subagent\":\"(Explore): find things\"}",
            "{\"mcp__github__create_issue\":\"\"}",
        ]);
    });

    test("no fixed last-N window: all active-context entries are kept (findings §6)", () => {
        const entries = Array.from({ length: 150 }, (_, i) => userEntry(`prompt ${i}`));
        const lines = buildTranscriptLines(asEntries(entries));
        expect(lines.length).toBe(150);
        expect(lines[0]).toBe("{\"user\":\"prompt 0\"}");
        expect(lines[149]).toBe("{\"user\":\"prompt 149\"}");
    });

    test("individual texts are truncated for prompt compactness", () => {
        const lines = buildTranscriptLines(asEntries([
            userEntry("x".repeat(600)),
            assistantToolEntry("bash", { command: "echo " + "y".repeat(600) }),
        ]));
        const user = JSON.parse(lines[0]!) as { user: string };
        const bash = JSON.parse(lines[1]!) as { bash: string };
        expect(user.user.length).toBe(500);
        expect(user.user.endsWith("…")).toBe(true);
        expect(bash.bash.length).toBe(500);
        expect(bash.bash.endsWith("…")).toBe(true);
    });

    test("empty/undefined entries yield no lines", () => {
        expect(buildTranscriptLines(undefined)).toEqual([]);
        expect(buildTranscriptLines(asEntries([]))).toEqual([]);
    });
});

// ============================================================================
// Model completion request + response (findings §1/§3/§8)
// ============================================================================

interface CapturedCall {
    modelId: string;
    context: { systemPrompt?: string; messages: Message[] };
    options: Record<string, unknown> | undefined;
}

const fakeModel = {
    id: "qwen-coder",
    name: "Qwen Coder",
    api: "openai-completions",
    provider: "llama.cpp",
    baseUrl: "http://classifier.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 32_768,
} as Model<Api>;

function assistantReply(text: string, stopReason: AssistantMessage["stopReason"] = "stop", errorMessage?: string): AssistantMessage {
    return {
        role: "assistant",
        content: text ? [{ type: "text", text }] : [],
        api: "openai-completions",
        provider: "llama.cpp",
        model: "qwen-coder",
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason,
        errorMessage,
        timestamp: Date.now(),
    };
}

describe("classifyBashCommand (llm backend)", () => {
    let captured: CapturedCall[] = [];
    /** Text returned as the assistant completion for the next request. */
    let replyText = "";
    /** Stop reason / error for the next reply (provider failures arrive as an error AssistantMessage). */
    let replyStopReason: AssistantMessage["stopReason"] = "stop";
    let replyErrorMessage: string | undefined;
    /** When set, `complete()` rejects (network failure). */
    let completeFailure: Error | undefined;
    let modelAvailable = true;
    let receivedSignal: AbortSignal | undefined;

    const registry = {
        find: (provider: string, modelId: string) =>
            modelAvailable && provider === fakeModel.provider && modelId === fakeModel.id
                ? fakeModel
                : undefined,
        complete: async (
            model: Model<Api>,
            context: { systemPrompt?: string; messages: Message[] },
            options?: Record<string, unknown>,
        ) => {
            receivedSignal = options?.signal as AbortSignal | undefined;
            captured.push({ modelId: model.id, context, options });
            if (completeFailure) throw completeFailure;
            return assistantReply(replyText, replyStopReason, replyErrorMessage);
        },
    } as unknown as ModelRegistry;

    beforeAll(async () => {
        await loadClassifier(registry);
    });

    beforeEach(() => {
        captured = [];
        replyText = "";
        replyStopReason = "stop";
        replyErrorMessage = undefined;
        completeFailure = undefined;
        modelAvailable = true;
        receivedSignal = undefined;
        setIntentFiles([]);
    });

    /** Run one classification over a small fixture transcript. */
    async function classify(rules?: ParsedPermissions) {
        const entries = asEntries([
            userEntry("clean up the project"),
            assistantToolEntry("bash", { command: "ls -la" }),
        ]);
        return classifyBashCommand(
            "echo hello",
            undefined,
            sessionContext,
            entries,
            rules,
        );
    }

    test("request goes through modelRegistry.complete with the expected layout and properties", async () => {
        replyText = "{\"label\":\"allow\"}";
        const result = await classify();

        expect(result.decision).toBe("allow");
        expect(captured.length).toBe(1);

        const call = captured[0]!;
        expect(call.modelId).toBe("qwen-coder");
        expect(call.options).toMatchObject({
            temperature: 0,
            maxTokens: 4096,
            timeoutMs: 30_000,
            samplingParams: {
                response_format: {
                    type: "json_schema",
                    schema: {
                        title: "ClassificationResult",
                        type: "object",
                        properties: {
                            label: {
                                title: "Label",
                                type: "string",
                                enum: ["allow", "ask", "deny"],
                            },
                        },
                        required: ["label"],
                        additionalProperties: false,
                    },
                },
            },
        });

        // Layout: [user intent?] + user(transcript) + assistant(prefill);
        // system prompt rides on the context, not the message list.
        expect(call.context.messages.map(m => m.role)).toEqual(["user", "assistant"]);
        expect(call.context.messages[0]!.content).toBe(
            "{\"user\":\"clean up the project\"}\n{\"bash\":\"ls -la\"}",
        );
        const prefill = call.context.messages[1] as AssistantMessage;
        expect(prefill.content).toEqual([{ type: "text", text: "{\"bash\":\"echo hello\"}" }]);
    });

    test("system prompt carries criteria, user rules and environment block", async () => {
        replyText = "{\"label\":\"ask\"}";
        await classify(makePerms({
            allow: [{ category: "bash", pattern: "git *" }],
            deny: [{ category: "bash", pattern: "curl *internal*" }],
        }));

        const system = captured[0]!.context.systemPrompt!;
        expect(system).toContain("{\"label\": \"allow\" | \"ask\" | \"deny\"}");
        expect(system).toContain("<user_rules>");
        expect(system).toContain("allow:\n- bash: git *");
        expect(system).toContain("deny:\n- bash: curl *internal*");
        expect(system).toContain("<environment>");
        expect(system).toContain("cwd: /home/user/project");
        expect(system).toContain("gitRemote: github.com");
        expect(system).toContain("agentTouchedFiles: src/a.ts, src/b.ts");
        expect(system).toContain("gitStatus:\n M src/a.ts\n?? .env");
    });

    test("user instruction files (AGENTS.md) are sent as a separate user-intent message before the transcript", async () => {
        replyText = "{\"label\":\"allow\"}";
        setIntentFiles([{ path: "/home/user/project/AGENTS.md", content: "# Project rules\nBe careful." }]);
        const result = await classify();

        expect(result.decision).toBe("allow");
        const messages = captured[0]!.context.messages;
        expect(messages.map(m => m.role)).toEqual(["user", "user", "assistant"]);
        expect(messages[0]!.content).toContain("user's AGENTS.md configuration");
        expect(messages[0]!.content).toContain("<user_claude_md path=\"/home/user/project/AGENTS.md\">");
        expect(messages[0]!.content).toContain("Be careful.");
        // Transcript stays in the following user message.
        expect(messages[1]!.content).toContain("{\"bash\":\"ls -la\"}");
    });

    test("empty instruction files produce no intent message", async () => {
        replyText = "{\"label\":\"allow\"}";
        setIntentFiles([{ path: "/x/AGENTS.md", content: "   " }]);
        await classify();
        expect(captured[0]!.context.messages.map(m => m.role)).toEqual(["user", "assistant"]);
    });

    test("labels are mapped case-insensitively", async () => {
        replyText = "{\"label\":\" DENY \"}";
        const result = await classify();
        expect(result.decision).toBe("deny");
        expect(result.reason).toContain("label=deny");
    });

    test("malformed model output fails closed to ask", async () => {
        replyText = "sure, I can run that!";
        const result = await classify();
        expect(result.decision).toBe("ask");
        expect(result.reason).toContain("LLM classifier request failed");
    });

    test("unknown label fails closed to ask", async () => {
        replyText = "{\"label\":\"maybe\"}";
        const result = await classify();
        expect(result.decision).toBe("ask");
    });

    test("provider error stop reason fails closed to ask", async () => {
        replyStopReason = "error";
        replyErrorMessage = "HTTP 500 Internal Server Error";
        const result = await classify();
        expect(result.decision).toBe("ask");
        expect(result.reason).toContain("HTTP 500");
    });

    test("network failure from complete() fails closed to ask", async () => {
        completeFailure = new Error("connect ECONNREFUSED 127.0.0.1:8080");
        const result = await classify();
        expect(result.decision).toBe("ask");
        expect(result.reason).toContain("LLM classifier request failed");
        expect(result.reason).toContain("ECONNREFUSED");
    });

    test("missing model in the registry fails closed to ask", async () => {
        modelAvailable = false;
        const result = await classify();
        expect(result.decision).toBe("ask");
        expect(result.reason).toContain("llama.cpp/qwen-coder");
    });

    test("caller abort signal is passed through to complete()", async () => {
        replyText = "{\"label\":\"allow\"}";
        const controller = new AbortController();
        const entries = asEntries([userEntry("hi")]);
        await classifyBashCommand("echo hi", controller.signal, sessionContext, entries);
        expect(receivedSignal).toBe(controller.signal);
    });

    test("transcript falls back to a placeholder when the session is empty", async () => {
        replyText = "{\"label\":\"allow\"}";
        await classifyBashCommand("echo hi", undefined, sessionContext, undefined);
        const messages = captured[0]!.context.messages;
        expect(messages[0]!.content).toBe("(no prior session activity)");
    });
});
