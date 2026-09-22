/**
 * Rendering of MCP tool-call rows: the tool name plus a preview of the params.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "bun:test";

import { formatArgsPreview, renderMcpCall } from "../src/render";

/** Identity theme: keeps assertions readable (no ANSI codes). */
const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
} as unknown as Theme;

describe("formatArgsPreview", () => {
    test("formats key=value pairs with quoted strings", () => {
        expect(formatArgsPreview({ server: "gh", limit: 10, verbose: true }))
            .toBe("server=\"gh\" limit=10 verbose=true");
    });

    test("returns an empty string for missing or empty args", () => {
        expect(formatArgsPreview(undefined)).toBe("");
        expect(formatArgsPreview(null)).toBe("");
        expect(formatArgsPreview({})).toBe("");
        expect(formatArgsPreview("text")).toBe("");
        expect(formatArgsPreview([1, 2])).toBe("");
    });

    test("collapses whitespace and truncates long string values", () => {
        const long = `line one\nline two ${"x".repeat(80)}`;
        const preview = formatArgsPreview({ text: long });
        expect(preview).not.toContain("\n");
        expect(preview.length).toBeLessThan(80);
        expect(preview.endsWith("\"")).toBe(true);
    });

    test("collapses objects and hides extra params", () => {
        const args = {
            filter: { state: "open", labels: ["bug", "urgent"] },
            a: 1,
            b: 2,
            c: 3,
            d: 4,
            e: 5,
            f: 6,
        };
        const preview = formatArgsPreview(args);
        expect(preview).toContain("filter={\"state\":\"open\"");
        expect(preview).toContain("+1 more");
        expect(preview).not.toContain(" f=6");
    });

    test("handles circular objects without throwing", () => {
        const circular: Record<string, unknown> = { name: "loop" };
        circular.self = circular;
        expect(formatArgsPreview({ obj: circular })).toContain("obj=");
    });
});

describe("renderMcpCall", () => {
    test("shows the tool name and the call params", () => {
        const lines = renderMcpCall("mcp__gh__list_issues", { repo: "pi", limit: 5 }, theme).render(80);
        expect(lines.join("\n").trimEnd()).toBe("mcp__gh__list_issues repo=\"pi\" limit=5");
    });

    test("shows just the name when there are no params", () => {
        const lines = renderMcpCall("mcp_list_prompts", {}, theme).render(80);
        expect(lines.join("\n").trimEnd()).toBe("mcp_list_prompts");
    });
});
