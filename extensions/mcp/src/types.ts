/**
 * Shared types for the MCP extension.
 */

/** Transport hints for a server config. */
export type McpTransportType = "stdio" | "http" | "sse";

/** A single configured MCP server (mirrors the standard mcpServers config file). */
export interface McpServerConfig {
    /** Key/name of the server in the config file. */
    key: string;
    /** Human-readable name shown in the TUI. Defaults to `key`. */
    label: string;
    /** Which transport family to use. */
    type: McpTransportType;
    /** stdio transport: command + args. */
    command?: string;
    args?: string[];
    /** Environment for the spawned stdio process. Values may include ${VAR} placeholders. */
    env?: Record<string, string>;
    /** Working directory for the spawned stdio process. */
    cwd?: string;
    /** HTTP/SSE transport: endpoint URL. */
    url?: string;
    /** Extra HTTP headers for url-based transports. Values may include ${VAR} placeholders. */
    headers?: Record<string, string>;
    /** Custom request init passed to StreamableHTTPClientTransport (Authorization etc.). */
    requestInit?: RequestInit;
    /** OAuth: one of "authorization_code" (interactive), "client_credentials", "none". */
    auth?: "authorization_code" | "client_credentials" | "none";
    /** Client credentials for the OAuth client_credentials flow. */
    clientId?: string;
    clientSecret?: string;
    /** Optional bearer token supplied statically (no OAuth round trip). */
    token?: string;
    /** Optional tool-name prefix overriding the default `mcp__<key>__`. */
    toolPrefix?: string;
    /** Disable this server without removing the entry. */
    disabled?: boolean;
}

/**
 * The on-disk config file shape. Keyed exactly like Claude Code / desktop MCP configs
 * (`mcpServers`).
 */
export interface McpConfigFile {
    mcpServers?: Record<string, Record<string, unknown>>;
}

/** Status of a connected server, surfaced by `/mcp`. */
export interface McpServerStatus {
    server: McpServerConfig;
    connected: boolean;
    tools: number;
    instructions?: string;
    error?: string;
}
