import { describe, expect, test } from "bun:test";

import { parseClaudePerms } from "../permission-parsing";
import { checkPermission } from "./check";
import { makePerms } from "./test-helpers";

describe("checkPermission: MCP tools (mcp__<server>__<tool>)", () => {
    test("bare server rule allows every tool on that server", async () => {
        const perms = makePerms({ allow: [{ category: "mcp__github", pattern: "*" }] });
        expect((await checkPermission("mcp__github__create_issue", {}, perms)).decision).toBe("allow");
        expect((await checkPermission("mcp__github__list_prs", {}, perms)).decision).toBe("allow");
    });

    test("dashes in rules match pi's underscore-normalized tool names", async () => {
        // Pi replaces every character other than letters, digits, and `_` with
        // `_`, so a server named `chrome-devtools` is invoked as
        // `mcp__chrome_devtools__take_screenshot`, while Claude settings rules
        // keep the dashed original name.
        const perms = makePerms({ allow: [{ category: "mcp__chrome-devtools__take_screenshot", pattern: "*" }] });
        expect((await checkPermission("mcp__chrome_devtools__take_screenshot", {}, perms)).decision).toBe("allow");
        expect((await checkPermission("mcp__chrome_devtools__navigate_page", {}, perms)).decision).toBe("ask");
    });

    test("dashed server rule allows every tool of the normalized server", async () => {
        const perms = makePerms({ allow: [{ category: "mcp__hf-mcp-server", pattern: "*" }] });
        expect((await checkPermission("mcp__hf_mcp_server__hub_repo_details", {}, perms)).decision).toBe("allow");
        expect((await checkPermission("mcp__hf_mcp_server__hub_uploads", {}, perms)).decision).toBe("allow");
    });

    test("dashed tool-segment wildcard matches normalized names", async () => {
        const perms = makePerms({ allow: [{ category: "mcp__chrome-devtools__get_*", pattern: "*" }] });
        expect((await checkPermission("mcp__chrome_devtools__get_console_messages", {}, perms)).decision).toBe("allow");
        expect((await checkPermission("mcp__chrome_devtools__take_snapshot", {}, perms)).decision).toBe("ask");
    });

    test("server wildcard rule (mcp__github__*) allows every tool on that server", async () => {
        const perms = makePerms({ allow: [{ category: "mcp__github__*", pattern: "*" }] });
        expect((await checkPermission("mcp__github__create_issue", {}, perms)).decision).toBe("allow");
    });

    test("server wildcard rule does not match a different server", async () => {
        const perms = makePerms({ allow: [{ category: "mcp__github__*", pattern: "*" }] });
        expect((await checkPermission("mcp__gitlab__create_issue", {}, perms)).decision).toBe("ask");
    });

    test("specific tool rule matches only that tool", async () => {
        const perms = makePerms({ allow: [{ category: "mcp__github__create_issue", pattern: "*" }] });
        expect((await checkPermission("mcp__github__create_issue", {}, perms)).decision).toBe("allow");
        expect((await checkPermission("mcp__github__list_prs", {}, perms)).decision).toBe("ask");
    });

    test("tool-segment wildcard matches get_* tools", async () => {
        const perms = makePerms({ allow: [{ category: "mcp__github__get_*", pattern: "*" }] });
        expect((await checkPermission("mcp__github__get_issue", {}, perms)).decision).toBe("allow");
        expect((await checkPermission("mcp__github__create_issue", {}, perms)).decision).toBe("ask");
    });

    test("global mcp__* deny blocks every MCP tool", async () => {
        const perms = makePerms({ deny: [{ category: "mcp__*", pattern: "*" }] });
        expect((await checkPermission("mcp__github__create_issue", {}, perms)).decision).toBe("deny");
        expect((await checkPermission("mcp__sentry__list_issues", {}, perms)).decision).toBe("deny");
    });

    test("server name matching is literal (mcp__github does not match mcp__github_evil)", async () => {
        const perms = makePerms({ allow: [{ category: "mcp__github", pattern: "*" }] });
        expect((await checkPermission("mcp__github_evil__rustle", {}, perms)).decision).toBe("ask");
    });

    test("tool allow rule does not match a different tool with a similar normalized name", async () => {
        const perms = makePerms({ allow: [{ category: "mcp__github__get_issue", pattern: "*" }] });
        expect((await checkPermission("mcp__github__get_issue", {}, perms)).decision).toBe("allow");
        expect((await checkPermission("mcp__github__get_issue_evil", {}, perms)).decision).toBe("ask");
    });

    test("deny rule takes priority over a broader allow rule", async () => {
        const perms = makePerms({
            deny: [{ category: "mcp__github__delete_*", pattern: "*" }],
            allow: [{ category: "mcp__github", pattern: "*" }],
        });
        expect((await checkPermission("mcp__github__delete_repo", {}, perms)).decision).toBe("deny");
        expect((await checkPermission("mcp__github__list_prs", {}, perms)).decision).toBe("allow");
    });

    test("ask rule takes priority over allow", async () => {
        const perms = makePerms({
            ask: [{ category: "mcp__github__push", pattern: "*" }],
            allow: [{ category: "mcp__github", pattern: "*" }],
        });
        expect((await checkPermission("mcp__github__push", {}, perms)).decision).toBe("ask");
    });

    test("no matching rule defaults to ask", async () => {
        const perms = makePerms({});
        expect((await checkPermission("mcp__github__create_issue", {}, perms)).decision).toBe("ask");
    });
});

describe("parseClaudePerms: MCP rules", () => {
    test("parses MCP permission entries into category + * pattern", () => {
        const config = JSON.stringify({
            permissions: {
                allow: ["mcp__github__create_issue", "mcp__github", "mcp__sentry__*"],
                deny: ["mcp__*"],
            },
        });
        const result = parseClaudePerms(config);
        expect(result.allow.some(r => r.category === "mcp__github__create_issue" && r.pattern === "*")).toBe(true);
        expect(result.allow.some(r => r.category === "mcp__github" && r.pattern === "*")).toBe(true);
        expect(result.allow.some(r => r.category === "mcp__sentry__*" && r.pattern === "*")).toBe(true);
        expect(result.deny.some(r => r.category === "mcp__*" && r.pattern === "*")).toBe(true);
    });

    test("MCP allow rules parsed from claude settings drive checkPermission", async () => {
        const config = JSON.stringify({
            permissions: {
                allow: ["mcp__github__create_issue"],
            },
        });
        const merged = parseClaudePerms(config);
        expect((await checkPermission("mcp__github__create_issue", {}, merged)).decision).toBe("allow");
        expect((await checkPermission("mcp__github__other", {}, merged)).decision).toBe("ask");
    });
});
