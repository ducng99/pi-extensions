/**
 * Discovers and parses MCP server configuration.
 *
 * Resolution order:
 *   1. Project: `<cwd>/.mcp.json`
 *   2. Project: `<cwd>/mcp.json`
 *   3. Global:   `~/.mcp.json`
 *
 * Project entries win; global entries fill any not already declared. Secrets may
 * be referenced as `${VAR}` and are interpolated from the environment.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import type { McpConfigFile, McpServerConfig, McpTransportType } from "./types";

/** Where a server config was declared. */
export type McpServerSource = "project" | "global";

/** Global MCP servers file. */
export function globalConfigFile(): string {
    return join(homedir(), ".mcp.json");
}

/** Directory holding per-server OAuth credentials. */
export function authDir(): string {
    return join(homedir(), ".pi", "agent", "mcp", "auth");
}

function expandEnv(value: string, missing: string[]): string {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (match, name: string, def?: string) => {
        const env = process.env[name];
        if (env !== undefined && env !== "") return env;
        if (def !== undefined) return def;
        missing.push(name);
        return match; // unset + no default: keep unexpanded text as-is
    });
}

function normalize(key: string, raw: Record<string, unknown>, missing: string[]): McpServerConfig | null {
    if (!key) return null;

    const command = typeof raw.command === "string" ? raw.command : undefined;
    const url = typeof raw.url === "string" ? raw.url : undefined;

    let type: McpTransportType = url ? "http" : "stdio";
    if (command) type = "stdio";
    if (raw.type === "sse" || raw.type === "streamable") type = raw.type === "sse" ? "sse" : "http";

    const envRaw = raw.env && typeof raw.env === "object" ? (raw.env as Record<string, string>) : undefined;
    const headersRaw = raw.headers && typeof raw.headers === "object" ? (raw.headers as Record<string, string>) : undefined;

    return {
        key,
        label: typeof raw.label === "string" && raw.label ? raw.label : key,
        type,
        command: command ? expandEnv(command, missing) : undefined,
        args: Array.isArray(raw.args) ? (raw.args as string[]).map(v => expandEnv(v, missing)) : undefined,
        env: envRaw ? expandEntries(envRaw, missing) : undefined,
        cwd: typeof raw.cwd === "string" ? expandEnv(raw.cwd, missing) : undefined,
        url: url ? expandEnv(url, missing) : undefined,
        headers: headersRaw ? expandEntries(headersRaw, missing) : undefined,
        requestInit: raw.requestInit && typeof raw.requestInit === "object" ? (raw.requestInit as RequestInit) : undefined,
        auth: raw.auth as McpServerConfig["auth"] | undefined,
        clientId: typeof raw.clientId === "string" ? raw.clientId : undefined,
        clientSecret: typeof raw.clientSecret === "string" ? raw.clientSecret : undefined,
        token: typeof raw.token === "string" ? raw.token : undefined,
        toolPrefix: typeof raw.toolPrefix === "string" ? raw.toolPrefix : undefined,
        disabled: raw.disabled === true || raw.disabled === "true",
    };
}

function expandEntries(obj: Record<string, string>, missing: string[]): Record<string, string> {
    return Object.fromEntries(Object.entries(obj).map(([key, value]) => [key, expandEnv(String(value), missing)]));
}

/** Read a JSON config file, returning its raw value or null. */
export function loadConfigFile(path: string): McpConfigFile | null {
    if (!existsSync(path)) return null;
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as McpConfigFile;
        return parsed && typeof parsed === "object" ? parsed : null;
    }
    catch {
        return null;
    }
}

function parseServers(file: McpConfigFile | null): { servers: Record<string, McpServerConfig>; missingEnv: Record<string, string[]> } {
    const servers: Record<string, McpServerConfig> = {};
    const missingEnv: Record<string, string[]> = {};
    if (!file?.mcpServers || typeof file.mcpServers !== "object") return { servers, missingEnv };
    for (const [key, value] of Object.entries(file.mcpServers)) {
        if (!value || typeof value !== "object") continue;
        const missing: string[] = [];
        const config = normalize(key, value as Record<string, unknown>, missing);
        if (config) servers[key] = config;
        if (missing.length) missingEnv[key] = missing;
    }
    return { servers, missingEnv };
}

/** A server config plus where it was declared and any unset env refs seen. */
export interface ConfigEntry {
    config: McpServerConfig;
    source: McpServerSource;
    missingEnv: string[];
}

/**
 * Load all non-disabled server configs from project + global sources, tagged
 * with where each entry was declared. Project entries win over global ones for
 * the same key.
 */
export function loadServersWithSource(cwd: string): ConfigEntry[] {
    const merged: Record<string, ConfigEntry> = {};

    const project = loadConfigFile(join(cwd, ".mcp.json")) ?? loadConfigFile(join(cwd, "mcp.json"));
    const projectParsed = parseServers(project);
    for (const [key, cfg] of Object.entries(projectParsed.servers)) {
        merged[key] = { config: cfg, source: "project", missingEnv: projectParsed.missingEnv[key] ?? [] };
    }

    const global = loadConfigFile(globalConfigFile());
    const globalParsed = parseServers(global);
    for (const [key, cfg] of Object.entries(globalParsed.servers)) {
        if (!(key in merged)) merged[key] = { config: cfg, source: "global", missingEnv: globalParsed.missingEnv[key] ?? [] };
    }

    return Object.values(merged).filter(entry => !entry.config.disabled);
}

/**
 * Load all non-disabled server configs plus the set of unset env vars that had
 * no `${VAR:-default}` fallback, keyed by server. Used to surface warnings.
 */
export function loadServersWithMissing(cwd: string): { servers: McpServerConfig[]; missingEnv: Record<string, string[]> } {
    const entries = loadServersWithSource(cwd);
    const missingEnv: Record<string, string[]> = {};
    for (const entry of entries) {
        if (entry.missingEnv.length) missingEnv[entry.config.key] = entry.missingEnv;
    }
    return { servers: entries.map(entry => entry.config), missingEnv };
}

/** Load all non-disabled server configs from project + global sources. */
export function loadServers(cwd: string): McpServerConfig[] {
    return loadServersWithSource(cwd).map(entry => entry.config);
}

/** Serialize a config back to a wire object (used by `/mcp` display). */
export function toWire(config: McpServerConfig): Record<string, unknown> {
    const wire: Record<string, unknown> = { type: config.type };
    if (config.command) wire.command = config.command;
    if (config.args) wire.args = config.args;
    if (config.env) wire.env = config.env;
    if (config.cwd) wire.cwd = config.cwd;
    if (config.url) wire.url = config.url;
    if (config.headers) wire.headers = config.headers;
    if (config.auth) wire.auth = config.auth;
    if (config.clientId) wire.clientId = config.clientId;
    if (config.clientSecret) wire.clientSecret = config.clientSecret;
    if (config.token) wire.token = config.token;
    if (config.toolPrefix) wire.toolPrefix = config.toolPrefix;
    if (config.label && config.label !== config.key) wire.label = config.label;
    return wire;
}
