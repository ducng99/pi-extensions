import { beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";
import * as fs from "fs";

import type { AgentConfig } from "../types";

class MockChildProcess extends EventEmitter {
    pid = 9999;
    killed = false;
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    kill() {}
}

const mockSpawn = mock((_command: string, _args: string[], _options: unknown) => {
    void _command;
    void _args;
    void _options;
    const proc = new MockChildProcess();
    setTimeout(() => {
        proc.stdout.emit("data", '{"type":"message_start"}\n');
        proc.stdout.emit(
            "data",
            '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hello"}],"usage":{"input":10,"output":5}}}\n',
        );
        proc.emit("close", 0);
    }, 0);
    return proc;
});

const { runAgent, getBackgroundTaskInfo, listBackgroundTasks, setSpawnForTests } = await import("../run");

// Inject the mock spawner instead of mock.module("child_process"), which would
// globally override the module and break sibling test files that use real spawn.
setSpawnForTests(mockSpawn as never);

const agents: AgentConfig[] = [
    {
        name: "Test",
        description: "A test agent",
        source: "user",
        filePath: "test.md",
        systemPrompt: "",
    },
    {
        name: "Plan",
        description: "Plan agent",
        source: "default",
        filePath: "default:Plan",
        systemPrompt: "",
    },
];

function getModelValue(args: string[]): string | undefined {
    const idx = args.indexOf("--model");
    if (idx === -1 || idx + 1 >= args.length) return undefined;
    return args[idx + 1];
}

describe("runAgent", () => {
    beforeEach(() => {
        mockSpawn.mockClear();
    });

    test("spawns a pi process and parses JSONL output", async () => {
        const result = await runAgent("/tmp", agents, "Test", "say hello", undefined, undefined, undefined, undefined, undefined, results => ({ results }));
        expect(result.agent).toBe("Test");
        expect(result.agentSource).toBe("user");
        expect(result.exitCode).toBe(0);
        expect(result.messages.length).toBeGreaterThan(0);
        const final = result.messages[result.messages.length - 1];
        if (!final) throw new Error("expected final assistant message");
        expect(final.role).toBe("assistant");
        expect(final.content[0]).toEqual({ type: "text", text: "hello" });
        expect(result.usage.input).toBe(10);
        expect(result.usage.output).toBe(5);
    });

    test("returns an error for an unknown agent", async () => {
        const result = await runAgent("/tmp", agents, "Missing", "task", undefined, undefined, undefined, undefined, undefined, results => ({ results }));
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Unknown agent");
    });

    test("passes model flag when agent has a concrete model", async () => {
        const modelAgent: AgentConfig = {
            name: "ModelAgent",
            description: "Model agent",
            source: "user",
            filePath: "model.md",
            systemPrompt: "",
            model: "anthropic/claude-sonnet-4-20250514",
        };
        await runAgent("/tmp", [...agents, modelAgent], "ModelAgent", "task", undefined, undefined, undefined, undefined, undefined, results => ({ results }));
        const call = mockSpawn.mock.calls[0];
        if (!call) throw new Error("expected spawn call");
        const args = call[1];
        expect(args).toContain("--model");
        expect(getModelValue(args)).toBe("anthropic/claude-sonnet-4-20250514");
    });

    test("skips model flag when agent model is inherit", async () => {
        await runAgent("/tmp", agents, "Test", "task", undefined, undefined, undefined, undefined, undefined, results => ({ results }));
        const call = mockSpawn.mock.calls[0];
        if (!call) throw new Error("expected spawn call");
        const args = call[1];
        expect(args).not.toContain("--model");
    });

    test("modelOverride takes precedence over agent's configured model", async () => {
        const modelAgent: AgentConfig = {
            name: "ModelAgent",
            description: "Model agent",
            source: "user",
            filePath: "model.md",
            systemPrompt: "",
            model: "anthropic/claude-sonnet-4-20250514",
        };
        const result = await runAgent("/tmp", [...agents, modelAgent], "ModelAgent", "task", "openai/gpt-5", undefined, undefined, undefined, undefined, results => ({ results }));
        const call = mockSpawn.mock.calls[0];
        if (!call) throw new Error("expected spawn call");
        const args = call[1];
        expect(getModelValue(args)).toBe("openai/gpt-5");
        expect(result.model).toBe("openai/gpt-5");
    });

    test("modelOverride sets model flag even when agent has no configured model", async () => {
        await runAgent("/tmp", agents, "Test", "task", "openai/gpt-5", undefined, undefined, undefined, undefined, results => ({ results }));
        const call = mockSpawn.mock.calls[0];
        if (!call) throw new Error("expected spawn call");
        const args = call[1];
        expect(getModelValue(args)).toBe("openai/gpt-5");
    });

    test("writes claude-style permissions file from tools/disallowedTools", async () => {
        let captured: unknown = null;
        mockSpawn.mockImplementationOnce((_command, _args, options) => {
            const env = (options as { env?: NodeJS.ProcessEnv }).env;
            const permsPath = env?.["PI_SUBAGENT_PERMISSIONS_FILE"];
            if (permsPath) {
                captured = JSON.parse(fs.readFileSync(permsPath, "utf-8"));
            }
            const proc = new MockChildProcess();
            setTimeout(() => {
                proc.stdout.emit(
                    "data",
                    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hello"}],"usage":{"input":1,"output":1}}}\n',
                );
                proc.emit("close", 0);
            }, 0);
            return proc;
        });

        const restricted: AgentConfig = {
            name: "Restricted",
            description: "restricted agent",
            source: "user",
            filePath: "restricted.md",
            systemPrompt: "",
            tools: ["Read"],
            disallowedTools: ["Edit", "Write"],
        };
        await runAgent("/tmp", [...agents, restricted], "Restricted", "task", undefined, undefined, undefined, undefined, undefined, results => ({ results }));
        expect(captured).toEqual({
            permissions: {
                allow: ["Read"],
                ask: [],
                deny: ["Edit", "Write"],
            },
        });
    });

    test("does not set permissions env when agent has no tools", async () => {
        mockSpawn.mockImplementationOnce((_command, _args, options) => {
            const env = (options as { env?: NodeJS.ProcessEnv }).env;
            expect(env?.["PI_SUBAGENT_PERMISSIONS_FILE"]).toBeUndefined();
            const proc = new MockChildProcess();
            setTimeout(() => {
                proc.stdout.emit(
                    "data",
                    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hi"}],"usage":{"input":1,"output":1}}}\n',
                );
                proc.emit("close", 0);
            }, 0);
            return proc;
        });

        await runAgent("/tmp", agents, "Test", "task", undefined, undefined, undefined, undefined, undefined, results => ({ results }));
    });
});

describe("background task registry", () => {
    test("getBackgroundTaskInfo returns undefined for unknown id", () => {
        expect(getBackgroundTaskInfo("does-not-exist")).toBeUndefined();
    });

    test("listBackgroundTasks returns empty array initially", () => {
        expect(listBackgroundTasks()).toEqual([]);
    });
});
