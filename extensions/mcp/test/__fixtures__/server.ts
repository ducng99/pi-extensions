/**
 * Minimal MCP stdio test server used by registry.test.ts.
 * Run with: bun extensions/mcp/__fixtures__/server.ts
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "test-server", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "add",
            description: "Add two numbers",
            inputSchema: {
                type: "object",
                properties: {
                    a: { type: "number", description: "First operand" },
                    b: { type: "number", description: "Second operand" },
                },
                required: ["a", "b"],
            },
        },
        {
            name: "greet",
            description: "Say hello to a person",
            inputSchema: {
                type: "object",
                properties: {
                    name: { type: "string" },
                    excited: { type: "boolean", default: false },
                },
                required: ["name"],
            },
        },
    ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    if (name === "add") {
        const sum = Number(a.a ?? 0) + Number(a.b ?? 0);
        return {
            content: [{ type: "text", text: `result: ${sum}` }],
            structuredContent: { sum },
        };
    }
    if (name === "greet") {
        const text = `${a.excited ? "HELLO" : "Hello"}, ${String(a.name)}!`;
        return { content: [{ type: "text", text }] };
    }
    return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
});

await server.connect(new StdioServerTransport());
