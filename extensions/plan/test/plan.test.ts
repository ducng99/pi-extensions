import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { default as planExtension } from "../index";
import { createPlanPrompt } from "../renderer";
import type { PlanDetails } from "../schema";

// ============================================================================
// Minimal fake pi + ctx harness
// ============================================================================

const fakeTheme = {
    fg: (_c: string, s: string) => s,
    bold: (s: string) => s,
    italic: (s: string) => s,
    underline: (s: string) => s,
    strikethrough: (s: string) => s,
} as never;

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

type PersistedEntry = { type: "custom"; customType: string; data?: unknown };

function setupHarness() {
    let activeTools = ["read", "bash", "grep", "find", "ls", "ask_user_questions", "edit", "write", "webfetch", "websearch"];
    const tools = new Map<string, ToolDef>();
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => void | Promise<void> }>();
    const listeners = new Map<string, (event: Record<string, unknown>, ctx: unknown) => void | Promise<void>>();

    const bus: ((data: unknown) => void)[] = [];
    // Session entries persisted via pi.appendEntry, mirroring the session JSONL.
    const entries: PersistedEntry[] = [];

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
        appendEntry: (customType: string, data?: unknown) => {
            entries.push({ type: "custom", customType, data });
        },
        sendMessage: () => {},
        sendUserMessage: () => {},
    };

    planExtension(fakePi as never);

    const uiCalls = { prompts: 0 };
    const ctx = (cwd: string) => ({
        cwd,
        hasUI: true,
        mode: "tui",
        abort: () => {},
        sessionManager: { getEntries: () => [...entries] },
        ui: {
            notify: () => {},
            setStatus: () => {},
            theme: fakeTheme,
            custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => { render(w: number): string[] }) => {
                uiCalls.prompts++;
                // Build and render the component to exercise the prompt UI.
                const comp = factory({ requestRender: () => {}, terminal: { rows: 40 } }, fakeTheme, undefined, () => {});
                comp.render(80);
                return "Chat more — stay in plan mode and keep chatting";
            },
            select: () => {
                uiCalls.prompts++;
                return Promise.resolve("Chat more — stay in plan mode and keep chatting");
            },
        },
    });

    return {
        togglePlan: (cwd: string) => commands.get("plan")!.handler("", ctx(cwd)),
        getActiveTools: () => activeTools,
        setActiveTools: (names: string[]) => {
            activeTools = [...names];
        },
        getEntries: () => [...entries],
        setSessionEntries: (other: PersistedEntry[]) => {
            entries.splice(0, entries.length, ...other);
        },
        sessionStart: (cwd: string) => listeners.get("session_start")!({ type: "session_start", reason: "new" }, ctx(cwd)),
        executionEnd: (toolName: string, cwd: string) =>
            listeners.get("tool_result")!({ toolName }, ctx(cwd)),
        selectCount: () => uiCalls.prompts,
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

    test("plan mode persists in the session and is restored on session_start", async () => {
        const h = setupHarness();
        dir = await mkdtemp(join(tmpdir(), "plan-test-"));
        const before = h.getActiveTools();
        await h.togglePlan(dir);
        const planTools = h.getActiveTools();
        expect(planTools).not.toEqual(before);

        // The toggle persisted a plan:mode entry carrying the pre-plan-mode tools.
        expect(h.getEntries()).toHaveLength(1);
        expect(h.getEntries()[0]).toEqual({
            type: "custom",
            customType: "plan:mode",
            data: { active: true, toolsBefore: before, includedGuide: true },
        });

        // Simulate an extension reload: a fresh harness (empty in-memory state)
        // bound to the same persisted entries. /reload keeps the agent's current
        // (plan) tool set active, so prime the fresh harness with plan tools.
        const reloaded = setupHarness();
        reloaded.setSessionEntries(h.getEntries());
        reloaded.setActiveTools(planTools);
        await reloaded.sessionStart(dir);
        expect(reloaded.getActiveTools()).toEqual(planTools);

        // Plan mode is fully functional after restore: write_plan works…
        const res = await reloaded.executeTool("write_plan", { filename: "restored", content: "restored plan" }, dir);
        expect(res.details.filename).toBe("restored.md");
        // …and toggle-off restores the persisted pre-plan-mode tool set, not the
        // plan tools that were active at reload time.
        await reloaded.togglePlan(dir);
        expect(reloaded.getActiveTools()).toEqual(before);
        // Toggling off also records the new state in the session.
        const last = reloaded.getEntries()[reloaded.getEntries().length - 1];
        expect(last).toEqual({ type: "custom", customType: "plan:mode", data: { active: false, includedGuide: false } });
    });

    test("brand-new session without a plan:mode entry starts with plan mode off", async () => {
        const h = setupHarness();
        dir = await mkdtemp(join(tmpdir(), "plan-test-"));

        await h.sessionStart(dir);
        // No plan:mode entry → write_plan refuses to run.
        const res = await h.executeTool("write_plan", { filename: "x", content: "y" }, dir);
        expect(res.content[0]?.text ?? "").toContain("plan mode is not active");
    });

    test("createPlanPrompt renders the plan and resolves via the select list", () => {
        const tui = { requestRender: () => {} };

        let chosen: string | null = null;
        const comp = createPlanPrompt("roadmap.md", "# Roadmap\n\nstep 1", {
            tui: tui as never,
            theme: fakeTheme,
            done: (c) => {
                chosen = c;
            },
        }) as unknown as { render(w: number): string[]; handleInput(data: string): void };

        const lines = comp.render(80);
        expect(lines.length).toBeGreaterThan(0);
        const text = lines.join("\n");
        expect(text).toContain("Roadmap");
        // Header with the plan filename, plus the options and help line below.
        expect(text).toContain("Plan roadmap.md");
        expect(text).toContain("Implement now");
        expect(text).toContain("esc cancel");

        // Enter selects the first option ("Implement now").
        comp.handleInput("\r");
        expect(chosen!).toBe("Implement now — exit plan mode and continue working");
    });

    test("createPlanPrompt Esc behaves like Chat more (stays in plan mode)", () => {
        const tui = { requestRender: () => {} };
        let chosen: string | null = null;
        const comp = createPlanPrompt("roadmap.md", "# Roadmap", {
            tui: tui as never,
            theme: fakeTheme,
            done: (c) => {
                chosen = c;
            },
        }) as unknown as { handleInput(data: string): void };

        comp.handleInput("\x1b");
        expect(chosen!).toBe("Chat more — stay in plan mode and keep chatting");
    });

    test("createPlanPrompt scrolls a long plan with PgDn/PgUp", () => {
        const tui = { requestRender: () => {}, terminal: { rows: 40 } };
        // 40 lines of content vs a 28-line viewport at 40 terminal rows
        // (rows - 12 chrome lines); 12 lines stay hidden either side.
        const longContent = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
        let chosen: string | null = null;
        const comp = createPlanPrompt("long.md", longContent, {
            tui: tui as never,
            theme: fakeTheme,
            done: (c) => {
                chosen = c;
            },
        }) as unknown as { render(w: number): string[]; handleInput(data: string): void };

        // Initial render: top of the plan, "... ↓ N more" indicator, no "↑".
        let lines = comp.render(80).join("\n");
        expect(lines).toContain("line 0");
        expect(lines).toContain("... ↓ 12 more");
        expect(lines).not.toContain("... ↑ ");
        expect(lines).toContain("Plan ready — what next?");

        // PgDn scrolls into the plan: an "↑" indicator appears now.
        comp.handleInput("\x1b[6~"); // pageDown
        lines = comp.render(80).join("\n");
        expect(lines).toContain("... ↑ 12 more");
        expect(lines).not.toContain("line 0");

        // Ctrl+U scrolls back up (works even in fullscreen mode, where PgUp is
        // consumed by pi's viewport to scroll the chat transcript).
        comp.handleInput("\x15"); // ctrl+u
        lines = comp.render(80).join("\n");
        expect(lines).toContain("line 0");
        expect(lines).not.toContain("... ↑ ");

        // Ctrl+D scrolls down again.
        comp.handleInput("\x04"); // ctrl+d
        lines = comp.render(80).join("\n");
        expect(lines).toContain("... ↑ 12 more");
        expect(lines).not.toContain("line 0");

        // Home jumps back to the top.
        comp.handleInput("\x1b[H"); // home
        lines = comp.render(80).join("\n");
        expect(lines).toContain("line 0");
        expect(lines).not.toContain("... ↑ ");

        // Enter still selects the first option after scrolling around.
        comp.handleInput("\r");
        expect(chosen!).toBe("Implement now — exit plan mode and continue working");
    });

    test("createPlanPrompt fills the whole terminal with the plan preview", () => {
        const tui = { requestRender: () => {}, terminal: { rows: 40 } };
        const longContent = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
        const comp = createPlanPrompt("long.md", longContent, {
            tui: tui as never,
            theme: fakeTheme,
            done: () => {},
        }) as unknown as { render(w: number): string[] };

        const lines = comp.render(100).join("\n");
        // Viewport = rows - chrome(12) = 28 region lines; the bottom "more"
        // indicator takes one slot, so content 0-26 shows, filling the screen.
        expect(lines).toContain("line 0");
        expect(lines).toContain("line 26");
        expect(lines).not.toContain("line 27");
        // pi-style border lines around the select list.
        const borderLine = "─".repeat(100);
        expect(lines).toContain(borderLine);
        expect(lines).toContain("... ↓ 12 more");
        expect(lines).toContain("Plan ready — what next?");
        expect(lines).toContain("Implement now");
    });

    test("createPlanPrompt shows error and empty results as plain text", () => {
        const tui = { requestRender: () => {}, terminal: { rows: 24 } };

        // An error result is rendered verbatim instead of being parsed as
        // markdown (so the raw message stays visible).
        const err = createPlanPrompt("plan.md", "## boom **failed**", {
            tui: tui as never,
            theme: fakeTheme,
            isError: true,
            done: () => {},
        }) as unknown as { render(w: number): string[] };
        let lines = err.render(80).join("\n");
        expect(lines).toContain("## boom **failed**");
        // The next-step options are still offered after an error.
        expect(lines).toContain("Implement now");

        // Empty content falls back to a placeholder line.
        const empty = createPlanPrompt("plan.md", "", {
            tui: tui as never,
            theme: fakeTheme,
            done: () => {},
        }) as unknown as { render(w: number): string[] };
        lines = empty.render(80).join("\n");
        expect(lines).toContain("(plan content unavailable)");
    });
});
