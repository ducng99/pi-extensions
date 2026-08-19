/**
 * Verifies the extension's default factory wires up commands, helper tools, and
 * lifecycle events cleanly (the same way pi loads it at mount time).
 */

import { describe, expect, test } from "bun:test";

import { default as mcpExtension } from "../src/index";

describe("mcp extension factory", () => {
    test("registers helper tools, the command, and lifecycle handlers", async () => {
        const tools: string[] = [];
        const commands: string[] = [];
        const events = new Map<string, unknown>();

        const fakePi = {
            registerTool: (t: { name: string }) => {
                tools.push(t.name);
            },
            registerCommand: (name: string) => {
                commands.push(name);
            },
            on: (ev: string, handler: unknown) => {
                events.set(ev, handler);
            },
        };

        await (mcpExtension as (pi: unknown) => unknown)(fakePi);

        expect(tools).toContain("mcp_list_resources");
        expect(tools).toContain("mcp_read_resource");
        expect(tools).toContain("mcp_list_prompts");
        expect(tools).toContain("mcp_get_prompt");
        expect(commands).toContain("mcp");
        expect(events.has("resources_discover")).toBe(true);
        expect(events.has("session_shutdown")).toBe(true);
    });
});
