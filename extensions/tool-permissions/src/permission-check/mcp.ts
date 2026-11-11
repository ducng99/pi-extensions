import { matchPattern } from "../../../shared/pattern-matching/index";
import type { ParsedPermissions } from "../permission-parsing";
import type { PermissionDecision } from "./types";

/**
 * True if the tool name uses the MCP naming convention `mcp__<server>__<tool>`.
 */
export function isMcpTool(name: string): boolean {
    return name.startsWith("mcp__") && name.indexOf("__", "mcp__".length) !== -1;
}

/**
 * Return the server-scoped prefix of an MCP name, e.g. `mcp__github__create_issue`
 * → `mcp__github__`. For a bare server name (`mcp__github`) it appends the
 * trailing separator so it compares equal to a tool's prefix.
 */
function mcpServerPrefix(name: string): string {
    const idx = name.indexOf("__", "mcp__".length);
    if (idx === -1) return name + "__";
    return name.slice(0, idx + 2);
}

/**
 * Normalize an MCP name the way pi names its MCP tools: every character other
 * than letters, digits, `_`, and `*` becomes `_` (e.g. the server
 * `chrome-devtools` yields the tool `mcp__chrome_devtools__take_screenshot`).
 * Claude settings rules keep the original server/tool names with dashes, so
 * both the rule spec and the incoming tool name must be normalized the same
 * way before comparison. `*` is preserved so wildcard specs keep their globs.
 */
function normalizeMcpName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_*]/g, "_");
}

/**
 * Match an MCP permission spec (`mcp__server`, `mcp__server__tool`, or any
 * `*`-wildcard variant) against a concrete MCP tool name. The server segment
 * must match literally; only the tool segment may use wildcards. Both sides
 * are normalized (see {@link normalizeMcpName}) so rules written with dashes
 * (allowed by Claude Code) match pi's underscore-normalized tool names.
 */
function mcpSpecMatches(rawSpec: string, rawToolName: string): boolean {
    const spec = normalizeMcpName(rawSpec);
    const toolName = normalizeMcpName(rawToolName);

    // Global wildcard matches any MCP tool.
    if (spec === "mcp__*") return true;
    if (!spec.startsWith("mcp__")) return false;

    const toolPrefix = mcpServerPrefix(toolName);

    // Bare server spec (e.g. `mcp__github`): matches every tool of that server.
    const specHasTool = spec.indexOf("__", "mcp__".length) !== -1;
    if (!specHasTool) {
        return spec + "__" === toolPrefix;
    }

    // Spec with a tool segment: server must match literally, tool may glob.
    const specServer = mcpServerPrefix(spec);
    if (specServer !== toolPrefix) return false;

    return matchPattern(spec.slice(specServer.length), toolName.slice(toolPrefix.length));
}

/**
 * Check whether an MCP tool call is permitted. MCP rules carry no path/arg
 * specifier in the pattern (Claude scopes them purely by tool name), so the
 * tool's name is matched, not an argument string.
 *
 * Rule specs use Claude Code's original naming (`mcp__chrome-devtools__...`)
 * while pi normalizes `-` (and any non-identifier character) to `_` in tool
 * names; {@link mcpSpecMatches} normalizes both sides before matching.
 */
export function checkMcpPermission(toolName: string, merged: ParsedPermissions): PermissionDecision | null {
    const matchesRule = (rule: { category: string; pattern: string }): boolean =>
        mcpSpecMatches(rule.category, toolName) && matchPattern(rule.pattern, "");

    for (const rule of merged.deny) {
        if (matchesRule(rule)) return { decision: "deny" };
    }
    for (const rule of merged.ask) {
        if (matchesRule(rule)) return { decision: "ask" };
    }
    for (const rule of merged.allow) {
        if (matchesRule(rule)) return { decision: "allow" };
    }
    return null;
}
