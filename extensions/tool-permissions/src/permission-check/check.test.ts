import { describe, expect, test } from "bun:test";

import { parseClaudePerms } from "../permission-parsing";
import { checkPermission } from "./check";
import { makePerms } from "./test-helpers";

describe("checkPermission: non-bash tools unchanged", () => {
    test("out-of-bounds access names the checked path", async () => {
        const perms = makePerms({ allow: [{ category: "read", pattern: "*" }] });
        const result = await checkPermission("read", { path: "/etc/passwd" }, perms, "/home/user/project");
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toBe("⚠ Accessing outside allowed directories: /etc/passwd");
            expect(result.outOfBoundsPath).toBe("/etc/passwd");
        }
    });

    test("in-bounds access carries no out-of-bounds path", async () => {
        const perms = makePerms({ allow: [{ category: "read", pattern: "*" }] });
        const result = await checkPermission("read", { path: "src/main.ts" }, perms, "/home/user/project");
        expect(result.decision).toBe("allow");
        if (result.decision === "allow") {
            expect(result.outOfBoundsPath).toBeUndefined();
        }
    });

    test("read tool still works normally", async () => {
        const perms = makePerms({ deny: [{ category: "read", pattern: ".env" }] });
        const result = await checkPermission("read", { path: ".env" }, perms);
        expect(result.decision).toBe("deny");
    });

    test("edit tool still works normally", async () => {
        const perms = makePerms({ allow: [{ category: "edit", pattern: "src/*" }] });
        const result = await checkPermission("edit", { path: "src/main.ts" }, perms);
        expect(result.decision).toBe("allow");
    });
});

describe("checkPermission: sensitive .pi/.claude paths", () => {
    const cwd = "/home/user/project";

    test("asks for read on .pi/settings.json", async () => {
        const result = await checkPermission("read", { path: ".pi/settings.json" }, makePerms({}), cwd);
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toContain("sensitive");
        }
    });

    test("asks for read on .claude/settings.json", async () => {
        const result = await checkPermission("read", { path: ".claude/settings.json" }, makePerms({}), cwd);
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toContain("sensitive");
        }
    });

    test("asks for edit on .pi/agent.md", async () => {
        const result = await checkPermission("edit", { path: ".pi/agent.md" }, makePerms({}), cwd);
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toContain("sensitive");
        }
    });

    test("asks for write on .claude/commands.md", async () => {
        const result = await checkPermission("write", { path: ".claude/commands.md" }, makePerms({}), cwd);
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toContain("sensitive");
        }
    });

    test("asks for read on nested path inside .pi", async () => {
        const result = await checkPermission("read", { path: ".pi/agent/state.json" }, makePerms({}), cwd);
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toContain("sensitive");
        }
    });

    test("asks plainly for read on a plans file with no rules (not sensitive)", async () => {
        // Plans files are exempt from the sensitive-path check; the plain ask
        // comes from the no-rule default, not the sensitive check.
        const result = await checkPermission("read", { path: ".pi/plans/plan.md" }, makePerms({}), cwd);
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason ?? "").not.toContain("sensitive");
        }
    });

    test("allows read on a plans file with allow rule", async () => {
        const perms = makePerms({ allow: [{ category: "read", pattern: "*" }] });
        const result = await checkPermission("read", { path: ".pi/plans/plan.md" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("allows write on a plans file with allow rule", async () => {
        // write shares the "edit" rule category with edit/patch
        const perms = makePerms({ allow: [{ category: "edit", pattern: "*" }] });
        const result = await checkPermission("write", { path: ".claude/plans/my-feature.md" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("asks for read on nested path inside .claude", async () => {
        const result = await checkPermission("read", { path: ".claude/commands/custom.md" }, makePerms({}), cwd);
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toContain("sensitive");
        }
    });

    test("allows read on a normal path outside .pi/.claude", async () => {
        const perms = makePerms({ allow: [{ category: "read", pattern: "*" }] });
        const result = await checkPermission("read", { path: "src/main.ts" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("allows read on a normal path with no rules", async () => {
        // Default-allowed tools still work for non-sensitive paths
        const result = await checkPermission("read", { path: "src/main.ts" }, makePerms({}), cwd);
        expect(result.decision).toBe("ask"); // read is not default-allowed, but it's not sensitive
    });

    test("allows read on .pi when outside cwd (absolute path to home/.pi)", async () => {
        // Paths outside cwd are handled by out-of-bounds, not sensitive-path check
        const result = await checkPermission("read", { path: "/home/user/.pi/settings.json" }, makePerms({}), cwd);
        expect(result.decision).toBe("ask");
        if (result.decision === "ask" && result.reason) {
            expect(result.reason).not.toContain("sensitive");
        }
    });
});

describe("checkPermission: built-in ls/find/grep tools follow their bash-command rules", () => {
    test("ls tool matches Bash(ls *) with a path", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "ls *" }] });
        const result = await checkPermission("ls", { path: "src" }, perms);
        expect(result.decision).toBe("allow");
    });

    test("ls tool matches Bash(ls *) without a path", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "ls *" }] });
        const result = await checkPermission("ls", {}, perms);
        expect(result.decision).toBe("allow");
    });

    test("ls tool asks when no Bash(ls *) rule exists", async () => {
        const perms = makePerms({});
        const result = await checkPermission("ls", { path: "src" }, perms);
        expect(result.decision).toBe("ask");
    });

    test("find tool matches Bash(find *)", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "find *" }] });
        const result = await checkPermission("find", { pattern: "**/*.ts", path: "src" }, perms);
        expect(result.decision).toBe("allow");
    });

    test("find tool with root path is denied by Bash(find / *)", async () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "find / *" }] });
        const result = await checkPermission("find", { pattern: "*", path: "/" }, perms);
        expect(result.decision).toBe("deny");
    });

    test("find tool with non-root path is not denied by Bash(find / *)", async () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "find / *" }] });
        const result = await checkPermission("find", { pattern: "**/*.ts", path: "src" }, perms);
        expect(result.decision).toBe("ask");
    });

    test("grep tool is allowed by the Grep rule", async () => {
        const perms = makePerms({ allow: [{ category: "grep", pattern: "*" }] });
        const result = await checkPermission("grep", { pattern: "TODO", path: "src" }, perms);
        expect(result.decision).toBe("allow");
    });

    test("grep tool searching for .env is denied by Grep(.env)", async () => {
        const perms = makePerms({ deny: [{ category: "grep", pattern: ".env" }] });
        const result = await checkPermission("grep", { pattern: ".env" }, perms);
        expect(result.decision).toBe("deny");
    });
});

describe("checkPermission: default allowed tools", () => {
    test("allows ask_user_questions by default with no rules", async () => {
        const perms = makePerms({});
        const result = await checkPermission("ask_user_questions", {}, perms);
        expect(result.decision).toBe("allow");
    });

    test("allows subagent by default with no rules", async () => {
        const perms = makePerms({});
        const result = await checkPermission("subagent", {}, perms);
        expect(result.decision).toBe("allow");
    });

    test("allows codemode by default with no rules", async () => {
        const perms = makePerms({});
        const result = await checkPermission("codemode", {}, perms);
        expect(result.decision).toBe("allow");
    });

    test("explicit deny still overrides default allowed", async () => {
        const perms = makePerms({ deny: [{ category: "ask_user_questions", pattern: "*" }] });
        const result = await checkPermission("ask_user_questions", {}, perms);
        expect(result.decision).toBe("deny");
    });

    test("explicit ask still overrides default allowed", async () => {
        const perms = makePerms({ ask: [{ category: "ask_user_questions", pattern: "*" }] });
        const result = await checkPermission("ask_user_questions", {}, perms);
        expect(result.decision).toBe("ask");
    });

    test("unknown tool still defaults to ask", async () => {
        const perms = makePerms({});
        const result = await checkPermission("unknown_tool", {}, perms);
        expect(result.decision).toBe("ask");
    });
});

describe("checkPermission: subagent agent-name matching", () => {
    test("Agent(Explore) rule allows invoking the Explore agent", async () => {
        const perms = makePerms({ allow: [{ category: "subagent", pattern: "Explore" }] });
        const result = await checkPermission("subagent", { agent: "Explore" }, perms);
        expect(result.decision).toBe("allow");
    });

    test("Agent(*) wildcard allows any agent", async () => {
        const perms = makePerms({ allow: [{ category: "subagent", pattern: "*" }] });
        const result = await checkPermission("subagent", { agent: "research" }, perms);
        expect(result.decision).toBe("allow");
    });

    test("Agent(Explore) ask rule asks for the Explore agent", async () => {
        const perms = makePerms({ ask: [{ category: "subagent", pattern: "Explore" }] });
        const result = await checkPermission("subagent", { agent: "Explore" }, perms);
        expect(result.decision).toBe("ask");
    });

    test("Agent(Explore) ask rule does not match a different agent", async () => {
        // subagent is default-allowed, so a non-matching rule falls through to allow.
        const perms = makePerms({ ask: [{ category: "subagent", pattern: "Explore" }] });
        const result = await checkPermission("subagent", { agent: "researcher" }, perms);
        expect(result.decision).toBe("allow");
    });

    test("Agent(Explore) deny rule denies invoking the Explore agent", async () => {
        const perms = makePerms({ deny: [{ category: "subagent", pattern: "Explore" }] });
        const result = await checkPermission("subagent", { agent: "Explore" }, perms);
        expect(result.decision).toBe("deny");
    });

    test("Agent(Explore) deny rule does not deny a different agent", async () => {
        // subagent is default-allowed, so a non-matching deny falls through to allow.
        const perms = makePerms({ deny: [{ category: "subagent", pattern: "Explore" }] });
        const result = await checkPermission("subagent", { agent: "researcher" }, perms);
        expect(result.decision).toBe("allow");
    });

    test("Agent rule parsed from claude settings matches the agent name", async () => {
        const perms = parseClaudePerms(JSON.stringify({
            permissions: { allow: ["Agent(Explore)"] },
        }));
        const result = await checkPermission("subagent", { agent: "Explore" }, perms);
        expect(result.decision).toBe("allow");
    });
});

describe("checkPermission: file-path rules match by basename", () => {
    const parse = (deny: string[]) =>
        parseClaudePerms(JSON.stringify({ permissions: { deny } }));

    test("Read(.env) denies reading an absolute-path .env anywhere", async () => {
        const merged = parse(["Read(.env)"]);
        const result = await checkPermission(
            "read",
            { path: "~/personal/crawler/.env" },
            merged,
            "/home/tom/personal/crawler",
        );
        expect(result.decision).toBe("deny");
    });

    test("Read(.env) denies reading a cwd-relative .env", async () => {
        const merged = parse(["Read(.env)"]);
        const result = await checkPermission("read", { path: ".env" }, merged, "/tmp/proj");
        expect(result.decision).toBe("deny");
    });

    test("Read(.env*.local) denies .env.production.local in a subdirectory", async () => {
        const merged = parse(["Read(.env*.local)"]);
        const result = await checkPermission("read", { path: "/tmp/proj/apps/web/.env.production.local" }, merged, "/tmp/proj");
        expect(result.decision).toBe("deny");
    });

    test("Read(.env) does not deny unrelated files", async () => {
        const merged = parse(["Read(.env)"]);
        const result = await checkPermission("read", { path: "/tmp/proj/src/index.ts" }, merged, "/tmp/proj");
        expect(result.decision).toBe("ask");
    });

    test("Read(.env) does not deny .env.example", async () => {
        const merged = parse(["Read(.env)"]);
        const result = await checkPermission("read", { path: "/tmp/proj/.env.example" }, merged, "/tmp/proj");
        expect(result.decision).not.toBe("deny");
    });

    test("Read(src/**) still matches slash patterns against the full path", async () => {
        const merged = parse(["Read(src/*)"]);
        const result = await checkPermission("read", { path: "/tmp/proj/src/secret.ts" }, merged, "/tmp/proj");
        expect(result.decision).toBe("deny");
    });
});
