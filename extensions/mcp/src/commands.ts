/**
 * `/mcp` command and MCP helper tools (resources / prompts).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { loadServers, loadServersWithMissing } from "./config";
import type { Registry } from "./registry";
import type { McpServerStatus } from "./types";

function formatStatus(status: McpServerStatus): string {
    if (status.connected) return `● ${status.server.key} (${status.server.type}) — connected · ${status.tools} tool(s)`;
    return `○ ${status.server.key} (${status.server.type}) — failed: ${status.error ?? "unknown error"}`;
}

function statusTable(registry: Registry): string {
    const statuses = registry.statuses();
    if (statuses.length === 0) return "No MCP servers configured or connected.";
    return statuses.map(formatStatus).join("\n");
}

function missingEnvNote(cwd: string): string {
    const { missingEnv } = loadServersWithMissing(cwd);
    const lines: string[] = [];
    for (const [server, vars] of Object.entries(missingEnv)) {
        lines.push(`⚠ ${server}: unset env var${vars.length === 1 ? "" : "s"} ${vars.map(v => `"${v}"`).join(", ")} have no default — ${vars.length === 1 ? "it" : "they"} remain unexpanded. Set ${vars.map(v => `"${v}"`).join(" or ")}, or add a ":-default" fallback.`);
    }
    return lines.join("\n");
}

export function registerCommands(pi: ExtensionAPI, registry: Registry): void {
    const commandNames = ["status", "connect", "disconnect", "reconnect", "login", "tools", "config"];

    pi.registerCommand("mcp", {
        description: "Inspect, connect, disconnect, or re-authenticate MCP servers",
        getArgumentCompletions: (prefix: string) => {
            const items = commandNames.map(v => ({ value: v, label: v }));
            const filtered = items.filter(i => i.value.startsWith(prefix.toLowerCase()));
            return filtered.length ? filtered : items;
        },
        handler: async (args, ctx) => {
            const [command, key] = (args ?? "").trim().split(/\s+/);
            const servers = loadServers(ctx.cwd);

            switch (command) {
                case undefined:
                case "":
                case "status":
                case "list": {
                    const note = missingEnvNote(ctx.cwd);
                    ctx.ui.notify(statusTable(registry) + (note ? `\n\n${note}` : ""), "info");
                    break;
                }

                case "connect": {
                    if (key) {
                        const cfg = servers.find(s => s.key === key);
                        if (!cfg) {
                            ctx.ui.notify(`No server named "${key}".`, "error");
                            break;
                        }
                        await registry.connectOne(pi, cfg);
                    }
                    else {
                        await registry.connectAll(pi, ctx.cwd);
                    }
                    ctx.ui.notify(statusTable(registry), "info");
                    break;
                }

                case "disconnect": {
                    if (!key) {
                        ctx.ui.notify("Usage: /mcp disconnect <server>", "error");
                        break;
                    }
                    await registry.disconnect(key);
                    ctx.ui.notify(`Disconnected "${key}".`, "info");
                    break;
                }

                case "reconnect":
                case "login": {
                    if (!key) {
                        ctx.ui.notify("Usage: /mcp reconnect <server>   (triggers the OAuth flow when needed)", "error");
                        break;
                    }
                    const cfg = servers.find(s => s.key === key);
                    if (!cfg) {
                        ctx.ui.notify(`No server named "${key}".`, "error");
                        break;
                    }
                    const result = await registry.reauth(pi, cfg);
                    ctx.ui.notify(
                        result.connected ? `Reconnected "${key}" (${result.tools} tools).` : `Reconnect failed for "${key}": ${result.error}`,
                        result.connected ? "info" : "error",
                    );
                    break;
                }

                case "tools": {
                    if (!key) {
                        ctx.ui.notify("Usage: /mcp tools <server>", "error");
                        break;
                    }
                    const status = registry.statuses().find(s => s.server.key === key);
                    ctx.ui.notify(status?.connected ? `"${key}" exposes ${status.tools} tool(s).` : `"${key}" is not connected.`, "info");
                    break;
                }

                default: {
                    const lines = servers.map(s => `${s.key}: ${s.type} ${s.command ?? s.url ?? ""}`);
                    ctx.ui.notify(lines.length ? lines.join("\n") : "No servers configured.", "info");
                    break;
                }
            }
        },
    });
}

export function registerHelperTools(pi: ExtensionAPI, registry: Registry): void {
    const serverParam = Type.String({ description: "Server key (the name in the MCP config)." });

    pi.registerTool({
        name: "mcp_list_resources",
        label: "MCP - List Resources",
        description: "List the resources exposed by a connected MCP server.",
        parameters: Type.Object({ server: serverParam }),
        async execute(_id, params) {
            const data = await registry.listResources((params as { server: string }).server);
            return { content: [{ type: "text" as const, text: stringify(data) }], details: {} };
        },
    });

    pi.registerTool({
        name: "mcp_read_resource",
        label: "MCP - Read Resource",
        description: "Read a single resource from a connected MCP server by URI.",
        parameters: Type.Object({
            server: serverParam,
            uri: Type.String({ description: "The resource URI to read." }),
        }),
        async execute(_id, params) {
            const { server, uri } = params as { server: string; uri: string };
            const data = await registry.readResource(server, uri);
            return { content: [{ type: "text" as const, text: stringify(data) }], details: {} };
        },
    });

    pi.registerTool({
        name: "mcp_list_prompts",
        label: "MCP - List Prompts",
        description: "List the prompt templates exposed by a connected MCP server.",
        parameters: Type.Object({ server: serverParam }),
        async execute(_id, params) {
            const data = await registry.listPrompts((params as { server: string }).server);
            return { content: [{ type: "text" as const, text: stringify(data) }], details: {} };
        },
    });

    pi.registerTool({
        name: "mcp_get_prompt",
        label: "MCP - Get Prompt",
        description: "Resolve a prompt from a connected MCP server, optionally with arguments.",
        parameters: Type.Object({
            server: serverParam,
            name: Type.String({ description: "The prompt name." }),
            arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        }),
        async execute(_id, params) {
            const { server, name, arguments: promptArgs } = params as { server: string; name: string; arguments?: Record<string, unknown> };
            const data = await registry.getPrompt(server, name, promptArgs);
            return { content: [{ type: "text" as const, text: stringify(data) }], details: { prompt: name } };
        },
    });
}

function stringify(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2);
    }
    catch {
        return String(value);
    }
}
