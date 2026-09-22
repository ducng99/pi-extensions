/**
 * TUI rendering for MCP tool calls.
 *
 * Without a `renderCall`, pi's tool row falls back to showing only the tool
 * name. MCP tools take arbitrary, server-defined parameters, so the renderer
 * adds a compact one-line preview of the actual arguments.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** Max characters shown for a single parameter value. */
const MAX_VALUE_LENGTH = 48;
/** Max parameters shown before collapsing the rest into "+N more". */
const MAX_PARAMS = 6;

function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One-line rendering of a single parameter value. */
export function formatValue(value: unknown): string {
    if (typeof value === "string") {
        // Collapse newlines/whitespace so the preview stays on one line.
        const flat = value.replace(/\s+/g, " ").trim();
        return `"${truncate(flat, MAX_VALUE_LENGTH)}"`;
    }
    if (value === null || value === undefined) return String(value);
    if (typeof value !== "object") return String(value);
    try {
        const json = JSON.stringify(value);
        return truncate(json ?? String(value), MAX_VALUE_LENGTH);
    }
    catch {
        // Circular or otherwise unserialisable values.
        return "[unserializable]";
    }
}

/**
 * Compact `key=value` preview of a tool call's arguments, e.g.
 * `server="gh" query="list issues" limit=10`. Returns an empty string when
 * there is nothing to show.
 */
export function formatArgsPreview(args: unknown): string {
    if (!args || typeof args !== "object" || Array.isArray(args)) return "";
    const entries = Object.entries(args as Record<string, unknown>);
    if (entries.length === 0) return "";
    const shown = entries.slice(0, MAX_PARAMS);
    const parts = shown.map(([key, value]) => `${key}=${formatValue(value)}`);
    const hidden = entries.length - shown.length;
    if (hidden > 0) parts.push(`+${hidden} more`);
    return parts.join(" ");
}

/** Render an MCP tool call row: the tool name plus a preview of its params. */
export function renderMcpCall(name: string, args: unknown, theme: Theme): Text {
    const preview = formatArgsPreview(args);
    let text = theme.fg("toolTitle", theme.bold(name));
    if (preview) text += ` ${theme.fg("muted", preview)}`;
    return new Text(text, 0, 0);
}
