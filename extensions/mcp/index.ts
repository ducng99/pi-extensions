import type { ExtensionAPI, ExtensionContext, McpServerConfig } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export default function mcpExtension(pi: ExtensionAPI): void {
    pi.on("session_start", (_, ctx: ExtensionContext) => {
        if (!ctx.isProjectTrusted()) return;
        registerServersFromFile(pi, join(homedir(), ".mcp.json"));
        registerServersFromFile(pi, join(ctx.cwd, ".mcp.json"));
    });

    pi.on("resources_discover", (_, ctx) => {
        if (!ctx.isProjectTrusted()) return;
        registerServersFromFile(pi, join(homedir(), ".mcp.json"));
        registerServersFromFile(pi, join(ctx.cwd, ".mcp.json"));
    });
}

function registerServersFromFile(pi: ExtensionAPI, path: string): void {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return; // Missing or unparseable file
    }
    const servers = (parsed as { mcpServers?: Record<string, McpServerConfig> } | null)?.mcpServers;
    if (!servers || typeof servers !== "object") return;
    for (const [name, config] of Object.entries(servers)) {
        try {
            pi.registerMcpServer(name, config);
        }
        catch (err) {
            console.error(`[mcp] ${path}: could not register "${name}": ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
