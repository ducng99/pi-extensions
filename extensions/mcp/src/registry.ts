/**
 * MCP client registry: connects to configured servers, discovers their tools,
 * and registers them as pi tools. Supports streamable-HTTP and stdio transports
 * with full OAuth (authorization-code flow, client_credentials, static bearer).
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { TSchema } from "typebox";

import { loadServersWithSource } from "./config";
import { formatToolResult } from "./format";
import { schemaFromParameters } from "./jsonSchema";
import { InteractiveOAuthProvider, loopback, makeAuthProvider } from "./oauth";
import type { McpServerConfig, McpServerStatus } from "./types";

const CLIENT_NAME = "pi-mcp";
const CLIENT_VERSION = "1.0.0";

/** Replace characters not allowed in pi tool/command names. */
function sanitizeName(name: string): string {
    const cleaned = name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+/, "");
    return cleaned || "tool";
}

function prefixFor(config: McpServerConfig): string {
    return config.toolPrefix && config.toolPrefix.length
        ? config.toolPrefix
        : `mcp__${sanitizeName(config.key)}__`;
}

function toolName(config: McpServerConfig, raw: string): string {
    return `${prefixFor(config)}${sanitizeName(raw)}`;
}

function statusOf(config: McpServerConfig, conn?: ConnectedServer, error?: string): McpServerStatus {
    return {
        server: config,
        connected: Boolean(conn),
        tools: conn?.toolCount ?? 0,
        instructions: conn?.instructions,
        error,
    };
}

interface ConnectedServer {
    config: McpServerConfig;
    client: Client;
    transport: StreamableHTTPClientTransport | StdioClientTransport;
    tools: McpToolSummary[];
    instructions?: string;
    toolCount: number;
}

interface McpToolSummary {
    name: string;
    description?: string;
    inputSchema: unknown;
}

export class Registry {
    private connections = new Map<string, ConnectedServer>();
    private registeredNames = new Set<string>();
    /** Last-known status for servers we've attempted (or successfully connected to). */
    private lastStatus = new Map<string, McpServerStatus>();

    async providerFor(config: McpServerConfig): Promise<OAuthClientProvider | undefined> {
        if (config.auth === "none") return undefined;
        if (config.auth === "client_credentials" && config.clientId) {
            return makeAuthProvider(config, 0);
        }
        if (config.token) return makeAuthProvider(config, 0);
        const port = await loopback.start();
        return makeAuthProvider(config, port);
    }

    private buildTransport(
        config: McpServerConfig,
        provider: OAuthClientProvider | undefined,
    ): StreamableHTTPClientTransport | StdioClientTransport {
        if (config.type === "stdio" && config.command) {
            return new StdioClientTransport({
                command: config.command,
                args: config.args,
                env: config.env,
                cwd: config.cwd,
                stderr: "pipe",
            });
        }
        if (!config.url) throw new Error(`MCP server "${config.key}" has neither a command nor a url`);
        const url = new URL(config.url);
        const init: RequestInit = { ...(config.requestInit ?? {}) };
        const headers = new Headers(init.headers);
        if (config.headers) {
            for (const [key, value] of Object.entries(config.headers)) headers.set(key, value);
        }
        if (config.headers) init.headers = headers;
        return new StreamableHTTPClientTransport(url, { authProvider: provider, requestInit: init });
    }

    private async attempt(config: McpServerConfig, provider: OAuthClientProvider | undefined, allowAuth: boolean): Promise<ConnectedServer> {
        const transport = this.buildTransport(config, provider);
        const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });

        try {
            await client.connect(transport);
        }
        catch (err) {
            const root = unwrapUnauthorized(err);
            if (root && allowAuth && provider instanceof InteractiveOAuthProvider) {
                const callback = await loopback.waitForCallback();
                if (!provider.validateState(callback.state)) {
                    throw new Error(`OAuth state mismatch for "${config.key}"`, { cause: err });
                }
                if (!callback.code) {
                    throw new Error(`No authorization code returned for "${config.key}"`, { cause: err });
                }
                if (transport instanceof StreamableHTTPClientTransport) {
                    await transport.finishAuth(callback.code);
                }
                await client.close().catch(() => {});
                return this.attempt(config, provider, false);
            }
            throw err;
        }

        const { tools } = await client.listTools();
        return {
            config,
            client,
            transport,
            tools: tools as McpToolSummary[],
            instructions: client.getInstructions(),
            toolCount: tools.length,
        };
    }

    async connectAll(pi: ExtensionAPI, cwd: string, opts?: { projectTrusted?: boolean }): Promise<McpServerStatus[]> {
        const statuses: McpServerStatus[] = [];
        for (const { config, source } of loadServersWithSource(cwd)) {
            // Project-declared servers expose project-local config/tools, so only
            // connect to them when the project is trusted. Global servers are fine.
            if (source === "project" && opts?.projectTrusted !== true) continue;
            statuses.push(await this.connectOne(pi, config));
        }
        return statuses;
    }

    async connectOne(pi: ExtensionAPI, config: McpServerConfig): Promise<McpServerStatus> {
        if (this.connections.has(config.key)) return statusOf(config, this.connections.get(config.key));
        try {
            const provider = await this.providerFor(config);
            const conn = await this.attempt(config, provider, true);
            this.connections.set(config.key, conn);
            this.registerTools(pi, conn);
            const status = statusOf(config, conn);
            this.lastStatus.set(config.key, status);
            return status;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const status = statusOf(config, undefined, message);
            this.lastStatus.set(config.key, status);
            return status;
        }
    }

    private registerTools(pi: ExtensionAPI, conn: ConnectedServer): void {
        const serverName = conn.config.key;
        const label = conn.config.label ?? serverName;
        for (const tool of conn.tools) {
            const name = toolName(conn.config, tool.name);
            if (this.registeredNames.has(name)) continue;
            this.registeredNames.add(name);
            const description = [
                tool.description?.trim() ?? "No description provided.",
                `\n\nThis tool is provided by the MCP server "${label}" (server key: ${serverName}).`,
            ].join("");
            pi.registerTool(defineTool(this, conn, tool, name, description));
        }
    }

    async call(serverKey: string, toolName: string, args: Record<string, unknown>): Promise<{ text: string; details: Record<string, unknown>; isError: boolean }> {
        const conn = this.require(serverKey);
        const result = await conn.client.callTool({ name: toolName, arguments: args ?? {} });
        const { text, details } = formatToolResult(result as never);
        return { text, details, isError: result.isError === true };
    }

    async listResources(serverKey: string): Promise<unknown> {
        const conn = this.require(serverKey);
        return conn.client.listResources();
    }

    async readResource(serverKey: string, uri: string): Promise<unknown> {
        const conn = this.require(serverKey);
        return conn.client.readResource({ uri });
    }

    async listPrompts(serverKey: string): Promise<unknown> {
        const conn = this.require(serverKey);
        return conn.client.listPrompts();
    }

    async getPrompt(serverKey: string, name: string, args?: Record<string, unknown>): Promise<unknown> {
        const conn = this.require(serverKey);
        return conn.client.getPrompt({ name, arguments: args as Record<string, string> });
    }

    async reauth(pi: ExtensionAPI, config: McpServerConfig): Promise<McpServerStatus> {
        await this.disconnect(config.key);
        try {
            const provider = await this.providerFor(config);
            const conn = await this.attempt(config, provider, true);
            this.connections.set(config.key, conn);
            this.registerTools(pi, conn);
            return statusOf(config, conn);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return statusOf(config, undefined, message);
        }
    }

    async disconnect(serverKey: string): Promise<void> {
        this.lastStatus.delete(serverKey);
        const conn = this.connections.get(serverKey);
        if (!conn) return;
        this.connections.delete(serverKey);
        for (const name of [...this.registeredNames]) {
            if (name.startsWith(prefixFor(conn.config))) this.registeredNames.delete(name);
        }
        await conn.client.close().catch(() => {});
        if (conn.transport instanceof StreamableHTTPClientTransport) {
            await conn.transport.terminateSession().catch(() => {});
        }
    }

    async disconnectAll(): Promise<void> {
        for (const key of [...this.connections.keys()]) await this.disconnect(key);
        loopback.stop();
    }

    /**
     * Snapshot of every server we know about: connected, failed-to-connect, or
     * configured-but-never-attempted (using its raw config as an "unattempted" status).
     * `configured` lets `/mcp status` reflect servers even if this process never
     * called `connectAll`/`connectOne` for them yet (e.g. added to the config file
     * after the last connect attempt).
     */
    statuses(configured: McpServerConfig[] = []): McpServerStatus[] {
        const byKey = new Map<string, McpServerStatus>();
        for (const config of configured) {
            byKey.set(config.key, statusOf(config, undefined, "not connected"));
        }
        for (const [key, status] of this.lastStatus) {
            byKey.set(key, status);
        }
        for (const [key, conn] of this.connections) {
            byKey.set(key, statusOf(conn.config, conn));
        }
        return [...byKey.values()];
    }

    private require(serverKey: string): ConnectedServer {
        const conn = this.connections.get(serverKey);
        if (!conn) throw new Error(`MCP server "${serverKey}" is not connected`);
        return conn;
    }
}

function unwrapUnauthorized(err: unknown): UnauthorizedError | undefined {
    if (err instanceof UnauthorizedError) return err;
    const cause = (err as { data?: { cause?: unknown } })?.data?.cause;
    return cause instanceof UnauthorizedError ? cause : undefined;
}

/** Build a pi tool definition that forwards to an MCP tool. */
function defineTool(registry: Registry, conn: ConnectedServer, tool: McpToolSummary, name: string, description: string): ToolDefinition {
    const serverKey = conn.config.key;
    const mcpToolName = tool.name;
    const parameters: TSchema = schemaFromParameters(tool.inputSchema);

    return {
        name,
        label: name,
        description,
        parameters,
        async execute(_toolCallId, params) {
            const result = await registry.call(serverKey, mcpToolName, (params ?? {}) as Record<string, unknown>);
            return {
                content: [{ type: "text" as const, text: result.text }],
                details: result.details,
                isError: result.isError,
            };
        },
    };
}
