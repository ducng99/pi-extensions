import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { default as planExtension } from "../index";
import { renderResult } from "../renderer";
import type { PlanDetails } from "../schema";

// ============================================================================
// Minimal fake pi + ctx harness
// ============================================================================

type PlanToolResult = {
    content: { type: string; text: string }[];
    details: PlanDetails;
};

type ToolDef = {
    name: string;
    execute: (
        toolCallId: string,
        params: unknown,
        signal?: unknown,
        onUpdate?: unknown,
        ctx?: unknown,
    ) => Promise<PlanToolResult>;
};

function setupHarness() {
    let activeTools = ["read", "bash", "grep", "find", "ls", "ask_user_questions", "edit", "write", "webfetch", "websearch"];
    const tools = new Map<string, ToolDef>();
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => void | Promise<void> }>();
    const listeners = new Map<string, (event: Record<string, unknown>, ctx: unknown) => void | Promise<void>>();

    const bus: ((data: unknown) => void)[] = [];

    const fakePi = {
        registerTool: (t: ToolDef) => tools.set(t.name, t),
        registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => void | Promise<void> }) =>
            commands.set(name, opts),
        on: (ev: string, handler: (event: Record<string, unknown>, ctx: unknown) => void | Promise<void>) =>
            listeners.set(ev, handler),
        events: {
            emit: (_channel: string, data: unknown) => bus.forEach(fn => fn(data)),
            on: (_channel: string, handler: (data: unknown) => void) => {
                bus.push(handler);
                return () => {};
            },
        },
        getActiveTools: () => [...activeTools],
        setActiveTools: (names: string[]) => {
            activeTools = [...names];
        },
        sendUserMessage: () => {},
    };

    planExtension(fakePi as never);

    const uiCalls = { selects: 0 };
    const ctx = (cwd: string) => ({
        cwd,
        hasUI: true,
        abort: () => {},
        ui: {
            notify: () => {},
            select: () => {
                uiCalls.selects++;
                return Promise.resolve("Chat more — stay in plan mode and keep chatting");
            },
        },
    });

    return {
        togglePlan: (cwd: string) => commands.get("plan")!.handler("", ctx(cwd)),
        getActiveTools: () => activeTools,
        sessionStart: (cwd: string) => listeners.get("session_start")!({ type: "session_start", reason: "new" }, ctx(cwd)),
        executionEnd: (toolName: string, cwd: string) =>
            listeners.get("tool_result")!({ toolName }, ctx(cwd)),
        selectCount: () => uiCalls.selects,
        executeTool: (name: string, params: unknown, cwd: string): Promise<PlanToolResult> => {
            const tool = tools.get(name);
            if (!tool) throw new Error(`tool ${name} not registered`);
            return tool.execute("id", params, undefined, undefined, ctx(cwd));
        },
    };
}

// ============================================================================
// Tests
// ============================================================================

describe("plan extension tools", () => {
    let dir: string;

    afterEach(async () => {
        if (dir) await rm(dir, { recursive: true, force: true });
    });

    test("write_plan delegates filename/content to pi's write tool and creates the plan file", async () => {
        const h = setupHarness();
        dir = await mkdtemp(join(tmpdir(), "plan-test-"));
        await h.togglePlan(dir);

        const res = await h.executeTool("write_plan", { filename: "roadmap", content: "# Plan\n\ndo things" }, dir);
        expect(res.details.filename).toBe("roadmap.md");
        expect(await readFile(res.details.fullPath, "utf8")).toBe("# Plan\n\ndo things");
    });

    test("edit_plan delegates old_text/new_text to pi's edit tool and returns updated content", async () => {
        const h = setupHarness();
        dir = await mkdtemp(join(tmpdir(), "plan-test-"));
        await h.togglePlan(dir);
        await h.executeTool("write_plan", { filename: "plan", content: "one two three" }, dir);

        const res = await h.executeTool("edit_plan", { filename: "plan", old_text: "two", new_text: "TWO" }, dir);
        expect(await readFile(res.details.fullPath, "utf8")).toBe("one TWO three");
    });

    test("tool_result only prompts after write_plan/edit_plan", async () => {
        const h = setupHarness();
        dir = await mkdtemp(join(tmpdir(), "plan-test-"));
        await h.togglePlan(dir);

        // Read-only and exploration tools must NOT trigger the prompt.
        for (const toolName of ["read", "bash", "grep", "find", "ls", "ask_user_questions"]) {
            await h.executionEnd(toolName, dir);
        }
        expect(h.selectCount()).toBe(0);

        // Only write_plan / edit_plan should prompt.
        await h.executionEnd("write_plan", dir);
        await h.executionEnd("edit_plan", dir);
        expect(h.selectCount()).toBe(2);
    });

    test("no state persistence: session_start resets plan mode and restores tools", async () => {
        const h = setupHarness();
        dir = await mkdtemp(join(tmpdir(), "plan-test-"));
        const before = h.getActiveTools();
        await h.togglePlan(dir);
        expect(h.getActiveTools()).not.toEqual(before);

        await h.sessionStart(dir);
        expect(h.getActiveTools()).toEqual(before);
    });

    test("renderResult returns a Container with children", () => {
        const theme = {
            fg: (_c: string, s: string) => s,
            bold: (s: string) => s,
            bg: (_c: string, s: string) => s,
            italic: (s: string) => s,
            underline: (s: string) => s,
            strikethrough: (s: string) => s,
        } as never;
        const result = { details: { filename: "plan.md", fullPath: "/x/plan.md" }, content: [{ type: "text", text: "# hi" }] } as never;
        const comp = renderResult(result, { expanded: false, isPartial: false }, theme);
        const children = (comp as { children: unknown[] }).children;
        expect(Array.isArray(children)).toBe(true);
        expect(children.length).toBeGreaterThan(0);
    });
});
