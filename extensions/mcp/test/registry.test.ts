/**
 * End-to-end test of the MCP client registry against a real stdio MCP server.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import * as os from "os";
import { tmpdir } from "os";
import { join } from "path";

import { Registry } from "../src/registry";

interface FakeTool {
    name: string;
    description?: string;
    parameters: unknown;
    execute?: (...args: unknown[]) => unknown;
}

describe("MCP client registry", () => {
    let dir: string;
    const registered: FakeTool[] = [];
    const fakePi = {
        registerTool: (tool: FakeTool) => {
            registered.push(tool);
        },
        on: () => {},
    };

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "pi-mcp-test-"));
        // Redirect the global `~/.mcp.json` lookup into the temp dir so the test
        // stays hermetic (ignores the real user's ~/.mcp.json).
        mock.module("os", () => ({
            ...os,
            homedir: () => dir,
        }));
        const serverPath = join(__dirname, "__fixtures__", "server.ts");
        const config = {
            mcpServers: {
                "test-server": {
                    command: process.execPath,
                    args: [serverPath],
                    type: "stdio",
                },
            },
        };
        writeFileSync(join(dir, ".mcp.json"), JSON.stringify(config, null, 2));
    });

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    test("connects trusted project servers, discovers tools, registers, and calls them", async () => {
        const registry = new Registry();
        const statuses = await registry.connectAll(fakePi as never, dir, { projectTrusted: true });

        expect(statuses).toHaveLength(1);
        expect(statuses[0]?.connected).toBe(true);
        expect(statuses[0]?.tools).toBe(2);

        const names = registered.map(t => t.name);
        expect(names).toContain("mcp__test_server__add");
        expect(names).toContain("mcp__test_server__greet");

        const addTool = registered.find(t => t.name === "mcp__test_server__add");
        expect(addTool?.parameters).toBeDefined();
        const props = (addTool?.parameters as { properties?: Record<string, unknown> })?.properties;
        expect(props?.a).toBeDefined();
        expect(props?.b).toBeDefined();

        const result = await registry.call("test-server", "add", { a: 19, b: 23 });
        expect(result.isError).toBe(false);
        expect(result.text).toContain("result: 42");

        const greet = await registry.call("test-server", "greet", { name: "pi", excited: true });
        expect(greet.text).toContain("HELLO, pi!");

        await registry.disconnectAll();
        expect(registry.statuses()).toHaveLength(0);
    });

    test("skips project servers when the project is not trusted", async () => {
        const registry = new Registry();
        const statuses = await registry.connectAll(fakePi as never, dir);

        // `.mcp.json` in `dir` is a project-level config; without trust it is skipped.
        expect(statuses).toHaveLength(0);
        expect(registry.statuses()).toHaveLength(0);
    });

    test("connects global servers regardless of project trust", async () => {
        // New project cwd with no project config of its own; the global config
        // (homedir mock = `dir`) is the only source of servers.
        const projectDir = join(dir, "nested-project");
        const registry = new Registry();

        // Untrusted project:
        let statuses = await registry.connectAll(fakePi as never, projectDir);
        expect(statuses).toHaveLength(1);
        expect(statuses[0]?.connected).toBe(true);
        await registry.disconnectAll();

        // Trusted project:
        statuses = await registry.connectAll(fakePi as never, projectDir, { projectTrusted: true });
        expect(statuses).toHaveLength(1);
        expect(statuses[0]?.connected).toBe(true);
        await registry.disconnectAll();
    });

    test("throws when calling a server that is not connected", async () => {
        const registry = new Registry();
        await expect(registry.call("missing", "add", {})).rejects.toThrow(/not connected/);
    });

    test("statuses() surfaces failed connection attempts instead of hiding them", async () => {
        const registry = new Registry();
        const badConfig = {
            key: "broken",
            label: "broken",
            type: "stdio" as const,
            command: join(dir, "does-not-exist-binary"),
        };

        const status = await registry.connectOne(fakePi as never, badConfig);
        expect(status.connected).toBe(false);

        // Regression: statuses() used to only reflect `this.connections`, so a
        // failed attempt vanished entirely and `/mcp status` looked like nothing
        // was configured at all.
        const statuses = registry.statuses();
        expect(statuses).toHaveLength(1);
        expect(statuses[0]?.server.key).toBe("broken");
        expect(statuses[0]?.connected).toBe(false);
    });

    test("statuses() lists configured servers that have never been attempted", async () => {
        const registry = new Registry();
        const configured = [{
            key: "never-attempted",
            label: "never-attempted",
            type: "stdio" as const,
            command: "whatever",
        }];

        const statuses = registry.statuses(configured);
        expect(statuses).toHaveLength(1);
        expect(statuses[0]?.connected).toBe(false);
        expect(statuses[0]?.error).toBe("not connected");
    });
});
