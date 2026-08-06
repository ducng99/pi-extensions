import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { loadServers, loadServersWithMissing } from "../src/config";

describe("MCP config env var expansion", () => {
    let dir: string;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "pi-mcp-config-test-"));
    });

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    function writeConfig(servers: Record<string, unknown>): void {
        writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
    }

    beforeEach(() => {
        delete process.env.MCP_TEST_TOKEN;
        delete process.env.MCP_TEST_PATH;
    });

    test("expands ${VAR} in command, args, env, url, headers", () => {
        process.env.MCP_TEST_PATH = "/opt/server/bin";
        writeConfig({
            srv: {
                type: "http",
                // untouched here but must not be treated as missing via braces
                url: "http://example.com/mcp",
            },
        });
        const [cfg] = loadServers(dir);
        expect(cfg?.url).toBe("http://example.com/mcp");
    });

    test("applies ${VAR:-default} fallback when var is unset", () => {
        writeConfig({
            srv: {
                type: "http",
                url: "http://example.com/${PORT:-8080}/mcp",
            },
        });
        const [cfg] = loadServers(dir);
        expect(cfg?.url).toBe("http://example.com/8080/mcp");
    });

    test("uses env value over default when set", () => {
        process.env.MCP_TEST_PORT = "9000";
        writeConfig({
            srv: {
                type: "http",
                url: "http://example.com/${MCP_TEST_PORT:-8080}/mcp",
            },
        });
        const [cfg] = loadServers(dir);
        expect(cfg?.url).toBe("http://example.com/9000/mcp");
    });

    test("keeps unexpanded ${VAR} and reports missing when unset with no default", () => {
        writeConfig({
            srv: {
                type: "stdio",
                command: "${MCP_TEST_PATH}/server",
                env: { TOKEN: "${MCP_TEST_TOKEN}" },
            },
        });
        const [cfg] = loadServers(dir);
        expect(cfg?.command).toBe("${MCP_TEST_PATH}/server");
        expect(cfg?.env?.TOKEN).toBe("${MCP_TEST_TOKEN}");

        const { missingEnv } = loadServersWithMissing(dir);
        expect(missingEnv.srv).toEqual(expect.arrayContaining(["MCP_TEST_PATH", "MCP_TEST_TOKEN"]));
    });

    test("empty env value falls back to default", () => {
        process.env.MCP_TEST_PORT = "";
        writeConfig({
            srv: {
                type: "http",
                url: "http://example.com/${MCP_TEST_PORT:-8080}/mcp",
            },
        });
        const [cfg] = loadServers(dir);
        expect(cfg?.url).toBe("http://example.com/8080/mcp");
    });
});
