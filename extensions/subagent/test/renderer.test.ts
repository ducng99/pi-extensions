import { Text } from "@earendil-works/pi-tui";
import { describe, expect, test } from "bun:test";

import { renderResult } from "../renderer";
import type { BackgroundTaskInfo, SubagentDetails } from "../types";

function mockTheme() {
    return {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
    };
}

function mockBackgroundResult(tasks: BackgroundTaskInfo[]) {
    return {
        content: [{ type: "text" as const, text: "Started background agents" }],
        details: {
            mode: "background",
            projectClaudeAgentsDir: null,
            projectOpencodeAgentsDir: null,
            results: [],
            backgroundTasks: tasks,
        } satisfies SubagentDetails,
    };
}

describe("renderResult", () => {
    test("renders background task details", () => {
        const result = mockBackgroundResult([
            {
                backgroundId: "abc123",
                pid: 12345,
                agent: "Explore",
                task: "Search for TODOs",
                outputPath: "/tmp/pi-subagent-bg-xxx/stdout.jsonl",
                errorPath: "/tmp/pi-subagent-bg-xxx/stderr.txt",
                startedAt: new Date().toISOString(),
            },
        ]);

        const component = renderResult(result, { expanded: false }, mockTheme());
        expect(component).toBeInstanceOf(Text);
        const rendered = component.render(200).join("\n");
        expect(rendered).toContain("background");
        expect(rendered).toContain("Explore");
        expect(rendered).toContain("abc123");
        expect(rendered).toContain("/tmp/pi-subagent-bg-xxx/stdout.jsonl");
    });

    test("renders multiple background tasks", () => {
        const result = mockBackgroundResult([
            {
                backgroundId: "task1",
                pid: 1,
                agent: "Explore",
                task: "t1",
                outputPath: "/tmp/1/stdout.jsonl",
                errorPath: "/tmp/1/stderr.txt",
                startedAt: new Date().toISOString(),
            },
            {
                backgroundId: "task2",
                pid: 2,
                agent: "Plan",
                task: "t2",
                outputPath: "/tmp/2/stdout.jsonl",
                errorPath: "/tmp/2/stderr.txt",
                startedAt: new Date().toISOString(),
            },
        ]);

        const component = renderResult(result, { expanded: false }, mockTheme());
        expect(component).toBeInstanceOf(Text);
        const rendered = component.render(200).join("\n");
        expect(rendered).toContain("Explore");
        expect(rendered).toContain("Plan");
        expect(rendered).toContain("task1");
        expect(rendered).toContain("task2");
    });
});
