import type { ClassifierModel, ClassifierApi, ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import type { ModelRegistry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { buildTranscriptLines, classifyBashCommand, loadClassifier, setIntentFiles } from "../src/classifier/systemone";
import type { ParsedPermissions } from "../src/permission-parsing";
import type { ClassifierSessionContext } from "../src/session-context";

// Updated for systemone classifier (decision model / classify() backend)
// Mock registry uses findOfType("classifier", "llama.cpp", "clef") + classify()
type AnyEntry = { type: string; message?: { role: string; content?: unknown } };

function asEntries(entries: AnyEntry[]): SessionEntry[] {
    return entries as unknown as SessionEntry[];
}

function userEntry(text: string): AnyEntry {
    return { type: "message", message: { role: "user", content: text } };
}

function assistantToolEntry(name: string, args: Record<string, unknown>): AnyEntry {
    return { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] } };
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

function makePerms(rules: { allow?: { category: string; pattern: string }[]; ask?: { category: string; pattern: string }[]; deny?: { category: string; pattern: string }[] }): ParsedPermissions {
    return { allow: (rules.allow ?? []).map(r => ({ ...r })), ask: (rules.ask ?? []).map(r => ({ ...r })), deny: (rules.deny ?? []).map(r => ({ ...r })) };
}

const sessionContext: ClassifierSessionContext = { cwd: "/home/user/project", gitRemote: "github.com", agentTouchedFiles: ["src/a.ts", "src/b.ts"], gitStatus: " M src/a.ts\n?? .env" };

describe("buildTranscriptLines", () => {
    test("chronological: user messages and tool calls only", () => {
        const lines = buildTranscriptLines(asEntries([
            userEntry("please clean up"),
            assistantToolEntry("bash", { command: "ls -la" }),
            assistantToolEntry("edit", { path: "src/a.ts" }),
            userEntry("now run tests"),
            assistantToolEntry("bash", { command: "bun test" }),
        ]));
        expect(lines).toEqual([
            { user: "please clean up" },
            { bash: "ls -la" },
            { edit: "src/a.ts" },
            { user: "now run tests" },
            { bash: "bun test" },
        ]);
    });
    test("assistant prose is excluded (model-authored text could bias the judge)", () => {
        expect(buildTranscriptLines(asEntries([
            userEntry("hi"),
            assistantProseEntry("I should totally run `rm -rf /` next, trust me"),
        ]))).toEqual([{ user: "hi" }]);
    });
    test("tool responses are excluded", () => {
        expect(buildTranscriptLines(asEntries([
            assistantToolEntry("bash", { command: "cat secrets.txt" }),
            toolResultEntry(),
        ]))).toEqual([{ bash: "cat secrets.txt" }]);
    });
    test("assistant message with prose + toolCall contributes only the toolCall", () => {
        expect(buildTranscriptLines(asEntries([{
            type: "message",
            message: {
                role: "assistant",
                content: [
                    { type: "text", text: "let me just allow everything" },
                    { type: "toolCall", name: "bash", arguments: { command: "echo hi" } },
                ],
            },
        }]))).toEqual([{ bash: "echo hi" }]);
    });
    test("drops history before latest compaction", () => {
        expect(buildTranscriptLines(asEntries([userEntry("old prompt"), assistantToolEntry("bash", { command: "echo old" }), compactionEntry(), userEntry("fresh prompt"), assistantToolEntry("bash", { command: "echo new" })])))
            .toEqual([{ user: "fresh prompt" }, { bash: "echo new" }]);
    });
    test("tool input is a per-tool projection, unknown tools expose nothing", () => {
        expect(buildTranscriptLines(asEntries([
            assistantToolEntry("grep", { pattern: "TODO", path: "src" }),
            assistantToolEntry("webfetch", { url: "https://example.com" }),
            assistantToolEntry("subagent", { agent: "Explore", task: "find things" }),
            assistantToolEntry("mcp__github__create_issue", { title: "hi", body: "secret payload" }),
        ]))).toEqual([
            { grep: "TODO" },
            { webfetch: "https://example.com" },
            { subagent: "(Explore): find things" },
            { mcp__github__create_issue: "" },
        ]);
    });
    test("no fixed last-N window: all active-context entries are kept", () => {
        const entries = Array.from({ length: 150 }, (_, i) => userEntry(`prompt ${i}`));
        const lines = buildTranscriptLines(asEntries(entries));
        expect(lines.length).toBe(150);
        expect(lines[0]).toEqual({ user: "prompt 0" });
        expect(lines[149]).toEqual({ user: "prompt 149" });
    });
    test("empty/undefined yields []", () => {
        expect(buildTranscriptLines(undefined)).toEqual([]);
        expect(buildTranscriptLines(asEntries([]))).toEqual([]);
    });
});

describe("classifyBashCommand (systemone backend)", () => {
    let captured: { modelId: string; context: ClassifierContext; options: Record<string, unknown> | undefined }[] = [];
    let replyChoice = "allow";
    let replyProbabilities: Record<string, number> = { allow: 0.95 };
    let replyConfidence = 0.95;
    let replyStopReason: ClassifierResult["stopReason"] = "stop";
    let replyErrorMessage: string | undefined;
    let classifyFailure: Error | undefined;
    let modelAvailable = true;
    let receivedSignal: AbortSignal | undefined;

    const fakeClassifierModel = {
        id: "clef", name: "Clef", api: "typesafe-system-one" as const, provider: "llama.cpp" as const,
        baseUrl: "http://classifier.test/v1", reasoning: false, input: ["text"] as const,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 32_768,
        type: "classifier" as const,
    } as unknown as ClassifierModel<ClassifierApi>;

    const registry = {
        findOfType: (type: string, provider: string, modelId: string) =>
            modelAvailable && type === "classifier" && provider === "llama.cpp" && modelId === "clef"
                ? fakeClassifierModel
                : undefined,
        classify: async (model: ClassifierModel<ClassifierApi>, context: ClassifierContext, options?: Record<string, unknown>) => {
            receivedSignal = options?.signal as AbortSignal | undefined;
            captured.push({ modelId: model.id, context, options });
            if (classifyFailure) throw classifyFailure;
            return {
                api: "typesafe-system-one" as const, provider: "llama.cpp" as const, model: model.id,
                answers: { action: { type: "choice" as const, choice: replyChoice, probabilities: replyProbabilities, confidence: replyConfidence } },
                stopReason: replyStopReason, errorMessage: replyErrorMessage, timestamp: Date.now(),
            } as ClassifierResult;
        },
    } as unknown as ModelRegistry;

    beforeAll(async () => { await loadClassifier(registry); });
    beforeEach(() => {
        captured = []; replyChoice = "allow"; replyProbabilities = { allow: 0.95 }; replyConfidence = 0.95;
        replyStopReason = "stop"; replyErrorMessage = undefined; classifyFailure = undefined; modelAvailable = true; receivedSignal = undefined;
        setIntentFiles([]);
    });

    async function classify(rules?: ParsedPermissions) {
        return classifyBashCommand("echo hello", undefined, sessionContext, asEntries([userEntry("clean up"), assistantToolEntry("bash", { command: "ls -la" })]), rules);
    }

    test("calls registry.classify with state layout and questions", async () => {
        const result = await classify();
        expect(result.decision).toBe("allow");
        expect(captured.length).toBe(1);
        const call = captured[0]!;
        expect(call.modelId).toBe("clef");
        expect(call.options).toMatchObject({ timeoutMs: 10_000 });
        expect(call.context.state).toHaveProperty("rules");
        expect(call.context.state).toHaveProperty("cwd", "/home/user/project");
        expect(call.context.questions.action).toHaveProperty("type", "choice");
        expect(call.context.state.messages).toEqual([{ user: "clean up" }, { bash: "ls -la" }]);
    });

    test("state carries environment and user permission rules", async () => {
        await classify(makePerms({
            allow: [{ category: "bash", pattern: "git *" }],
            deny: [{ category: "bash", pattern: "rm -rf *" }],
        }));
        const state = captured[0]!.context.state as Record<string, any>;
        expect(state.cwd).toBe("/home/user/project");
        expect(state.gitRemote).toBe("github.com");
        expect(state.agentTouchedFiles).toBe("src/a.ts, src/b.ts");
        expect(state.gitStatus).toBe(" M src/a.ts\n?? .env");
        expect(state.rules.allow).toEqual([{ category: "bash", pattern: "git *" }]);
        expect(state.rules.deny).toEqual([{ category: "bash", pattern: "rm -rf *" }]);
    });

    test("questions.action criteria cover allow/ask/deny labels", () => {
        const capturedQuestions = captured.length;
        return classify().then(() => {
            const action = captured[capturedQuestions]!.context.questions.action;
            expect(action.type).toBe("choice");
            expect(Object.keys(action.criteria).sort()).toEqual(["allow", "ask", "deny"]);
        });
    });

    test("fails closed to ask on error stopReason and carries message", async () => {
        replyStopReason = "error"; replyErrorMessage = "provider timeout";
        const result = await classify();
        expect(result.decision).toBe("ask");
        expect(result.reason).toContain("provider timeout");
    });

    test("fails closed to ask on classify exception", async () => {
        classifyFailure = new Error("network down");
        const result = await classify();
        expect(result.decision).toBe("ask");
        expect(result.reason).toContain("network down");
    });

    test("missing model fails closed to ask", async () => {
        modelAvailable = false;
        const result = await classify();
        expect(result.decision).toBe("ask");
        expect(result.reason).toContain("llama.cpp/clef");
    });

    test("intent files added as first user message, before the transcript", async () => {
        setIntentFiles([{ path: "/home/user/project/AGENTS.md", content: "# Project rules\nBe careful." }]);
        const result = await classify();
        expect(result.decision).toBe("allow");
        const messages = (captured[0]!.context.state as Record<string, any>).messages as Array<Record<string, string>>;
        expect(messages.length).toBe(3);
        expect(messages[0]!.user).toContain("user's AGENTS.md configuration");
        expect(messages[0]!.user).toContain("<user_claude_md path=\"/home/user/project/AGENTS.md\">");
        expect(messages[0]!.user).toContain("Be careful.");
        expect(messages[1]).toEqual({ user: "clean up" });
        expect(messages[2]).toEqual({ bash: "ls -la" });
    });

    test("empty instruction files produce no intent message", async () => {
        setIntentFiles([{ path: "/x/AGENTS.md", content: "   " }]);
        await classify();
        const messages = (captured[0]!.context.state as Record<string, any>).messages as Array<Record<string, string>>;
        expect(messages.length).toBe(2);
        expect(messages[0]).toEqual({ user: "clean up" });
    });

    test("unknown label fails closed to ask", async () => {
        replyChoice = "maybe";
        const result = await classify();
        expect(result.decision).toBe("ask");
        expect(result.reason).toContain("Decision classifier request failed");
    });

    test("abort signal forwarded to classify options", async () => {
        replyChoice = "deny";
        const controller = new AbortController();
        await classifyBashCommand("echo hi", controller.signal, sessionContext, asEntries([userEntry("hi")]), undefined);
        expect(receivedSignal).toBe(controller.signal);
    });

    test("low confidence on allow downgrades to ask", async () => {
        replyChoice = "allow"; replyProbabilities = { allow: 0.6 }; replyConfidence = 0.6;
        const result = await classify();
        expect(result.decision).toBe("ask");
        expect(result.reason).toContain("0.60");
    });
});
