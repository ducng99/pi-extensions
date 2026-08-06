/**
 * MCP (Model Context Protocol) integration for pi.
 *
 * Connects pi to external MCP servers (stdio / streamable-HTTP) and exposes
 * their tools to the agent, plus helper tools for MCP resources and prompts.
 * Full OAuth flows (authorization-code with browser loopback,
 * client_credentials, static bearer) are supported. Configure servers in
 * `<project>/.mcp.json` (or `<project>/mcp.json`) or `~/.pi/agent/mcp/servers.json`.
 *
 *   /mcp                    — show connection status
 *   /mcp connect [<key>]    — (re)connect all or one server
 *   /mcp reconnect <key>    — re-authenticate / reconnect (OAuth)
 *   /mcp disconnect <key>   — disconnect a server
 *
 * See extensions/mcp/README.md for the config format.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerCommands, registerHelperTools } from "./commands";
import { loadServersWithMissing } from "./config";
import { Registry } from "./registry";

export default function mcpExtension(pi: ExtensionAPI): void {
    const registry = new Registry();

    // Always available, independent of any server connection.
    registerCommands(pi, registry);
    registerHelperTools(pi, registry);

    pi.on("session_start", async (_event, ctx) => {
        const statuses = await registry.connectAll(pi, ctx.cwd, { projectTrusted: ctx.isProjectTrusted() });
        const connected = statuses.filter(s => s.connected).length;
        if (ctx.hasUI) {
            const { missingEnv } = loadServersWithMissing(ctx.cwd);
            const missing = Object.entries(missingEnv)
                .map(([server, vars]) => `${server}: ${vars.join(", ")}`)
                .join("; ");
            ctx.ui.notify(
                `MCP: ${connected}/${statuses.length} server${statuses.length === 1 ? "" : "s"} connected`
                + (missing ? ` — unset env vars (no default): ${missing}` : ""),
                connected === statuses.length ? "info" : "warning",
            );
        }
    });

    pi.on("session_shutdown", async () => {
        await registry.disconnectAll();
    });
}
