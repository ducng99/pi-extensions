import { describe, expect, test } from "bun:test";

import { SessionAllowlist } from "../src/session-allowlist";

describe("SessionAllowlist", () => {
    test("initially allows nothing", () => {
        const allowlist = new SessionAllowlist();
        expect(allowlist.allows("edit", { path: "src/a.ts" })).toBe(false);
        expect(allowlist.allows("read", { path: "src/a.ts" })).toBe(false);
        expect(allowlist.size).toBe(0);
    });

    test("add then allows the same tool+arg pair", () => {
        const allowlist = new SessionAllowlist();
        allowlist.add("edit", { path: "src/a.ts" });
        expect(allowlist.allows("edit", { path: "src/a.ts" })).toBe(true);
        expect(allowlist.size).toBe(1);
    });

    test("different arg produces a different key", () => {
        const allowlist = new SessionAllowlist();
        allowlist.add("edit", { path: "src/a.ts" });
        expect(allowlist.allows("edit", { path: "src/b.ts" })).toBe(false);
        expect(allowlist.size).toBe(1);
    });

    test("different tool produces a different key", () => {
        const allowlist = new SessionAllowlist();
        allowlist.add("edit", { path: "src/a.ts" });
        expect(allowlist.allows("read", { path: "src/a.ts" })).toBe(false);
        expect(allowlist.size).toBe(1);
    });

    test("keys match the permission rules' buildArgString conventions", () => {
        // The allowlist key for each tool must be the same string the
        // permission rules match against — so a session-allow decision
        // behaves like an explicit allow rule for that tool+argument.
        const allowlist = new SessionAllowlist();

        // File-path tools: key includes the path.
        allowlist.add("read", { path: ".env" });
        expect(allowlist.allows("read", { path: ".env" })).toBe(true);

        // Bash: full command (allowlist is bypassed in the extension for bash,
        // but the key is still correct so tests can validate it).
        allowlist.add("bash", { command: "ls -la" });
        expect(allowlist.allows("bash", { command: "ls -la" })).toBe(true);

        // Grep: pattern + path concatenated.
        allowlist.add("grep", { pattern: "TODO", path: "src" });
        expect(allowlist.allows("grep", { pattern: "TODO", path: "src" })).toBe(true);
        expect(allowlist.allows("grep", { pattern: "FIXME", path: "src" })).toBe(false);

        // Webfetch: URL.
        allowlist.add("webfetch", { url: "https://example.com" });
        expect(allowlist.allows("webfetch", { url: "https://example.com" })).toBe(true);
    });

    test("clear removes all entries", () => {
        const allowlist = new SessionAllowlist();
        allowlist.add("edit", { path: "src/a.ts" });
        allowlist.add("read", { path: "src/a.ts" });
        expect(allowlist.size).toBe(2);
        allowlist.clear();
        expect(allowlist.size).toBe(0);
        expect(allowlist.allows("edit", { path: "src/a.ts" })).toBe(false);
    });

    test("adding the same pair twice is idempotent", () => {
        const allowlist = new SessionAllowlist();
        allowlist.add("edit", { path: "src/a.ts" });
        allowlist.add("edit", { path: "src/a.ts" });
        expect(allowlist.size).toBe(1);
    });

    test("non-string args degrade to an empty arg segment", () => {
        // If a caller passes weird shapes (number, object) the allowlist still
        // functions without throwing — the key degrades to `${tool}:` and
        // anything else with the same degradation doesn't collide with real
        // string args.
        const allowlist = new SessionAllowlist();
        expect(() => allowlist.add("edit", { path: 42 as unknown as string })).not.toThrow();
        expect(() => allowlist.allows("edit", { path: 42 as unknown as string })).not.toThrow();
    });

    test("unknown tools also work (e.g. MCP tool names)", () => {
        const allowlist = new SessionAllowlist();
        allowlist.add("mcp__github__create_issue", {});
        expect(allowlist.allows("mcp__github__create_issue", {})).toBe(true);
        expect(allowlist.allows("mcp__github__list_prs", {})).toBe(false);
    });
});
