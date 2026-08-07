import { beforeAll, describe, expect, test } from "bun:test";

import { initParser } from "../../shared/bash-parser/index";
import { checkPermission, isOutOfBounds, REASON_BASH_COMPLEX, REASON_BASH_PARSE_ERROR } from "../src/permission-check";
import type { ParsedPermissions } from "../src/permission-parsing";
import { parseClaudePerms, parseOpencodePerms } from "../src/permission-parsing";

// Initialize parser before all tests
beforeAll(async () => {
    await initParser();
});

function makePerms(opts: {
    allow?: { category: string; pattern: string }[];
    ask?: { category: string; pattern: string }[];
    deny?: { category: string; pattern: string }[];
}): ParsedPermissions {
    return {
        allow: (opts.allow ?? []).map(r => ({ ...r })),
        ask: (opts.ask ?? []).map(r => ({ ...r })),
        deny: (opts.deny ?? []).map(r => ({ ...r })),
    };
}

describe("checkPermission: bash sub-command parsing", () => {
    test("denies `sleep 1; cat .env | echo` when `cat .env` is denied", () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "cat .env" }] });
        const result = checkPermission("bash", { command: "sleep 1; cat .env | echo" }, perms);
        expect(result.decision).toBe("deny");
    });

    test("denies when denied command is in a pipe", () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "cat .env" }] });
        const result = checkPermission("bash", { command: "cat .env | grep SECRET" }, perms);
        expect(result.decision).toBe("deny");
    });

    test("denies when denied command is in &&", () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "cat .env" }] });
        const result = checkPermission("bash", { command: "echo hello && cat .env" }, perms);
        expect(result.decision).toBe("deny");
    });

    test("denies when denied command is in ||", () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "cat .env" }] });
        const result = checkPermission("bash", { command: "false || cat .env" }, perms);
        expect(result.decision).toBe("deny");
    });

    test("denies when denied command is in a subshell", () => {
    // Subshells are kept as complex top-level commands; the deny rule must
    // match the whole subshell command string.
        const perms = makePerms({ deny: [{ category: "bash", pattern: "(cat .env)*" }] });
        const result = checkPermission("bash", { command: "(cat .env) | grep key" }, perms);
        expect(result.decision).toBe("deny");
    });

    test("asks when denied command is in command substitution", () => {
    // Command substitutions are complex; only whole-command deny rules apply.
        const perms = makePerms({ deny: [{ category: "bash", pattern: "cat .env" }] });
        const result = checkPermission("bash", { command: "echo $(cat .env)" }, perms);
        expect(result.decision).toBe("ask");
    });

    test("allows when all sub-commands match allow rules", () => {
        const perms = makePerms({
            allow: [
                { category: "bash", pattern: "echo *" },
                { category: "bash", pattern: "ls *" },
            ],
        });
        const result = checkPermission("bash", { command: "echo hello; ls -la" }, perms);
        expect(result.decision).toBe("allow");
    });

    test("asks when some sub-commands don't match any rule", () => {
        const perms = makePerms({
            allow: [{ category: "bash", pattern: "echo *" }],
        });
        const result = checkPermission("bash", { command: "echo hello; cat .env" }, perms);
        expect(result.decision).toBe("ask");
    });

    test("asks on complex commands (heredoc)", () => {
        const perms = makePerms({
            deny: [{ category: "bash", pattern: "cat" }],
        });
        const result = checkPermission("bash", { command: "cat <<EOF\nhello\nEOF" }, perms);
        expect(result.decision).toBe("ask");
    });

    test("asks on complex commands (process substitution)", () => {
        const perms = makePerms({
            deny: [{ category: "bash", pattern: "cat .env" }],
        });
        const result = checkPermission("bash", { command: "diff <(cat .env) <(cat .env.bak)" }, perms);
        expect(result.decision).toBe("ask");
    });

    test("deny takes priority: one denied sub-command overrides others being allowed", () => {
        const perms = makePerms({
            deny: [{ category: "bash", pattern: "cat .env" }],
            allow: [{ category: "bash", pattern: "echo *" }],
        });
        const result = checkPermission("bash", { command: "echo hello; cat .env" }, perms);
        expect(result.decision).toBe("deny");
    });

    test("asks when command substitution is present", () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "cat *" }] });
        const result = checkPermission("bash", { command: "echo $(cat .env)" }, perms);
        expect(result.decision).toBe("ask");
    });

    test("catch-all deny pattern * denies everything", () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "*" }] });
        const result = checkPermission("bash", { command: "echo hello; ls -la" }, perms);
        expect(result.decision).toBe("deny");
    });

    test("find -exec is a complex top-level command", () => {
    // find -exec is kept as a single complex command; the deny rule must match
    // the whole command string.
        const perms = makePerms({ deny: [{ category: "bash", pattern: "find *" }] });
        const result = checkPermission("bash", { command: "find . -name '*.tmp' -exec rm {} \\;" }, perms);
        expect(result.decision).toBe("deny");
    });
});

describe("checkPermission: non-bash tools unchanged", () => {
    test("read tool still works normally", () => {
        const perms = makePerms({ deny: [{ category: "read", pattern: ".env" }] });
        const result = checkPermission("read", { path: ".env" }, perms);
        expect(result.decision).toBe("deny");
    });

    test("edit tool still works normally", () => {
        const perms = makePerms({ allow: [{ category: "edit", pattern: "src/*" }] });
        const result = checkPermission("edit", { file_path: "src/main.ts" }, perms);
        expect(result.decision).toBe("allow");
    });
});

describe("checkPermission: default allowed tools", () => {
    test("allows ask_user_questions by default with no rules", () => {
        const perms = makePerms({});
        const result = checkPermission("ask_user_questions", {}, perms);
        expect(result.decision).toBe("allow");
    });

    test("allows subagent by default with no rules", () => {
        const perms = makePerms({});
        const result = checkPermission("subagent", {}, perms);
        expect(result.decision).toBe("allow");
    });

    test("explicit deny still overrides default allowed", () => {
        const perms = makePerms({ deny: [{ category: "ask_user_questions", pattern: "*" }] });
        const result = checkPermission("ask_user_questions", {}, perms);
        expect(result.decision).toBe("deny");
    });

    test("explicit ask still overrides default allowed", () => {
        const perms = makePerms({ ask: [{ category: "ask_user_questions", pattern: "*" }] });
        const result = checkPermission("ask_user_questions", {}, perms);
        expect(result.decision).toBe("ask");
    });

    test("unknown tool still defaults to ask", () => {
        const perms = makePerms({});
        const result = checkPermission("unknown_tool", {}, perms);
        expect(result.decision).toBe("ask");
    });
});

describe("checkPermission: bash redirection patterns", () => {
    test("allow `bun test *` permits `bun test 2>&1`", () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "bun test *" }] });
        const result = checkPermission("bash", { command: "bun test 2>&1" }, perms);
        expect(result.decision).toBe("allow");
    });

    test("allow `bun test *` permits `bun test --coverage 2>&1`", () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "bun test *" }] });
        const result = checkPermission("bash", { command: "bun test --coverage 2>&1" }, perms);
        expect(result.decision).toBe("allow");
    });

    test("allow `bun test *` permits `bun test > output.txt`", () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "bun test *" }] });
        const result = checkPermission("bash", { command: "bun test > output.txt" }, perms);
        expect(result.decision).toBe("allow");
    });

    test("deny `rm *` catches `rm file.txt 2>/dev/null`", () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "rm *" }] });
        const result = checkPermission("bash", { command: "rm file.txt 2>/dev/null" }, perms);
        expect(result.decision).toBe("deny");
    });
});

describe("checkPermission: bash out-of-bounds paths", () => {
    const cwd = "/home/user/project";

    test("allows commands with paths inside cwd", () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "cat *" }] });
        const result = checkPermission("bash", { command: "cat src/main.ts" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("asks for commands with absolute paths outside cwd", () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "cat *" }] });
        const result = checkPermission("bash", { command: "cat /etc/passwd" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("asks for commands with relative paths outside cwd", () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "cat *" }] });
        const result = checkPermission("bash", { command: "cat ../../../etc/passwd" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("allows commands with paths in additional directories", () => {
        const perms = makePerms({
            allow: [{ category: "bash", pattern: "cat *" }],
        });
        perms.additionalDirectories = ["/home/user/shared"];
        const result = checkPermission("bash", { command: "cat /home/user/shared/file.txt" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("allows commands with relative paths to additional directories", () => {
        const perms = makePerms({
            allow: [{ category: "bash", pattern: "cat *" }],
        });
        perms.additionalDirectories = ["../shared"];
        const result = checkPermission("bash", { command: "cat ../shared/file.txt" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("asks for commands with paths outside cwd and additional dirs", () => {
        const perms = makePerms({
            allow: [{ category: "bash", pattern: "cat *" }],
        });
        perms.additionalDirectories = ["/home/user/shared"];
        const result = checkPermission("bash", { command: "cat /home/user/other/file.txt" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("allows commands with no paths", () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "echo *" }] });
        const result = checkPermission("bash", { command: "echo hello" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("allows commands with flags but no paths", () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "ls *" }] });
        const result = checkPermission("bash", { command: "ls -la --color" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("asks for commands with ./ paths outside cwd", () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "cat *" }] });
        const result = checkPermission("bash", { command: "cat ./src/main.ts" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("deny still takes priority over out-of-bounds", () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "cat *" }] });
        const result = checkPermission("bash", { command: "cat /etc/passwd" }, perms, cwd);
        expect(result.decision).toBe("deny");
    });

    test("checks paths in sub-commands", () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "*" }] });
        const result = checkPermission("bash", { command: "echo $(cat /etc/passwd)" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("checks paths in piped commands", () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "*" }] });
        const result = checkPermission("bash", { command: "cat /etc/passwd | grep root" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("asks for redirection to file outside cwd", () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "echo *" }] });
        const result = checkPermission("bash", { command: "echo hello > /etc/outside.txt" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("asks for append redirection to file outside cwd", () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "echo *" }] });
        const result = checkPermission("bash", { command: "echo hello >> /etc/outside.txt" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("asks for stderr redirection to file outside cwd", () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "bun test *" }] });
        const result = checkPermission("bash", { command: "bun test 2> /tmp/errors.log" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("asks for combined output redirection to file outside cwd", () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "bun test *" }] });
        const result = checkPermission("bash", { command: "bun test &> /tmp/all.log" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("allows redirection to file inside cwd", () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "echo *" }] });
        const result = checkPermission("bash", { command: "echo hello > output.txt" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("allows redirection to /dev/null", () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "bun test *" }] });
        const result = checkPermission("bash", { command: "bun test 2>/dev/null" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("allows fd-to-fd redirection (2>&1)", () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "bun test *" }] });
        const result = checkPermission("bash", { command: "bun test 2>&1" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("asks for redirection in piped command to file outside cwd", () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "*" }] });
        const result = checkPermission("bash", { command: "cat src/main.ts | grep TODO > /tmp/results.txt" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });
});

describe("checkPermission: bash `cd` auto-allow", () => {
    const cwd = "/home/user/project";

    test("auto-allows `cd` within cwd without explicit allow rule", () => {
        const perms = makePerms({
            allow: [{ category: "bash", pattern: "head *" }],
        });
        const result = checkPermission(
            "bash",
            { command: "cd /home/user/project/src && head -100 file.ts" },
            perms,
            cwd,
        );
        expect(result.decision).toBe("allow");
    });

    test("auto-allows `cd` with relative path within cwd", () => {
        const perms = makePerms({
            allow: [{ category: "bash", pattern: "ls *" }],
        });
        const result = checkPermission(
            "bash",
            { command: "cd src/components && ls -la" },
            perms,
            cwd,
        );
        expect(result.decision).toBe("allow");
    });

    test("auto-allows `cd` within additional directories", () => {
        const perms = makePerms({
            allow: [{ category: "bash", pattern: "echo *" }],
        });
        perms.additionalDirectories = ["/home/user/shared"];
        const result = checkPermission(
            "bash",
            { command: "cd /home/user/shared && echo hello" },
            perms,
            cwd,
        );
        expect(result.decision).toBe("allow");
    });

    test("asks for `cd` outside cwd and additional dirs", () => {
        const perms = makePerms({
            allow: [{ category: "bash", pattern: "echo *" }],
        });
        const result = checkPermission(
            "bash",
            { command: "cd /etc && echo hello" },
            perms,
            cwd,
        );
        expect(result.decision).toBe("ask");
    });

    test("asks for `cd` with relative path escaping cwd", () => {
        const perms = makePerms({
            allow: [{ category: "bash", pattern: "echo *" }],
        });
        const result = checkPermission(
            "bash",
            { command: "cd ../../../etc && echo hello" },
            perms,
            cwd,
        );
        expect(result.decision).toBe("ask");
    });

    test("deny rule still takes priority over cd auto-allow", () => {
        const perms = makePerms({
            deny: [{ category: "bash", pattern: "cd /etc*" }],
            allow: [{ category: "bash", pattern: "echo *" }],
        });
        const result = checkPermission(
            "bash",
            { command: "cd /etc && echo hello" },
            perms,
            cwd,
        );
        expect(result.decision).toBe("deny");
    });

    test("auto-allows `cd` with flags like -P", () => {
        const perms = makePerms({
            allow: [{ category: "bash", pattern: "echo *" }],
        });
        const result = checkPermission(
            "bash",
            { command: "cd -P /home/user/project/src && echo hello" },
            perms,
            cwd,
        );
        expect(result.decision).toBe("allow");
    });

    test("does not auto-allow `cd` without a path argument", () => {
        const perms = makePerms({
            allow: [{ category: "bash", pattern: "echo *" }],
        });
        const result = checkPermission(
            "bash",
            { command: "cd && echo hello" },
            perms,
            cwd,
        );
        // `cd` alone with no arg doesn't match isCdInBounds, so it asks
        expect(result.decision).toBe("ask");
    });

    test("`cd` updates effective cwd for subsequent relative paths", () => {
        const perms = makePerms({
            allow: [{ category: "bash", pattern: "bun build *" }],
        });
        perms.additionalDirectories = ["/tmp"];
        const result = checkPermission(
            "bash",
            {
                command:
                    "cd /home/user/project && bun build --target=bun extensions/ask-user-questions/index.ts --outdir=/tmp/test-build 2>&1",
            },
            perms,
            cwd,
        );
        expect(result.decision).toBe("allow");
    });
});

describe("checkPermission: complex and error commands", () => {
    test("deny rule can match whole complex heredoc command", () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "cat <<EOF*" }] });
        const result = checkPermission("bash", { command: "cat <<EOF\nhello\nEOF" }, perms);
        expect(result.decision).toBe("deny");
    });

    test("deny rule can match whole complex process substitution command", () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "diff *" }] });
        const result = checkPermission("bash", { command: "diff <(cat .env) <(cat .env.bak)" }, perms);
        expect(result.decision).toBe("deny");
    });

    test("deny rule with wildcard matches complex heredoc command", () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "cat *" }] });
        const result = checkPermission("bash", { command: "cat <<EOF\nhello\nEOF" }, perms);
        expect(result.decision).toBe("deny");
    });

    test("unparseable command falls back to ask", () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "echo *" }] });
        const result = checkPermission("bash", { command: "echo \"unterminated" }, perms);
        expect(result.decision).toBe("ask");
    });

    test("asks with a reason when the command is too complex", () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "cat .env" }] });
        const result = checkPermission("bash", { command: "cat <<EOF\nhello\nEOF" }, perms);
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toBeDefined();
            expect(result.reason).toStrictEqual(REASON_BASH_COMPLEX);
        }
    });

    test("asks with a reason when the command fails to parse", () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "echo *" }] });
        const result = checkPermission("bash", { command: "echo \"unterminated" }, perms);
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toBeDefined();
            expect(result.reason).toStrictEqual(REASON_BASH_PARSE_ERROR);
        }
    });

    test("plain ask decisions have no reason", () => {
        const perms = makePerms({});
        const result = checkPermission("bash", { command: "curl https://example.com" }, perms);
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toBeUndefined();
        }
    });

    test("non-bash ask decisions have no reason", () => {
        const perms = makePerms({ ask: [{ category: "unknown_tool", pattern: "*" }] });
        const result = checkPermission("unknown_tool", {}, perms);
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toBeUndefined();
        }
    });
});

describe("isOutOfBounds: bash commands", () => {
    const cwd = "/home/user/project";

    // Bash bounds checking is handled in checkBashPermission with cd-aware
    // effective cwd tracking. isOutOfBounds always returns false for bash.
    test("returns false for bash command — bounds checked by checkBashPermission", () => {
        const result = isOutOfBounds("bash", { command: "cat /etc/passwd" }, cwd, []);
        expect(result).toBe(false);
    });

    test("returns false for non-bash tool inside cwd", () => {
        const result = isOutOfBounds("read", { path: "src/main.ts" }, cwd, []);
        expect(result).toBe(false);
    });

    test("returns true for non-bash tool outside cwd", () => {
        const result = isOutOfBounds("read", { path: "/etc/passwd" }, cwd, []);
        expect(result).toBe(true);
    });

    test("returns false for unknown tool", () => {
        const result = isOutOfBounds("unknown-tool", { path: "/etc/passwd" }, cwd, []);
        expect(result).toBe(false);
    });
});

describe("checkPermission: MCP tools (mcp__<server>__<tool>)", () => {
    test("bare server rule allows every tool on that server", () => {
        const perms = makePerms({ allow: [{ category: "mcp__github", pattern: "*" }] });
        expect(checkPermission("mcp__github__create_issue", {}, perms).decision).toBe("allow");
        expect(checkPermission("mcp__github__list_prs", {}, perms).decision).toBe("allow");
    });

    test("server wildcard rule (mcp__github__*) allows every tool on that server", () => {
        const perms = makePerms({ allow: [{ category: "mcp__github__*", pattern: "*" }] });
        expect(checkPermission("mcp__github__create_issue", {}, perms).decision).toBe("allow");
    });

    test("server wildcard rule does not match a different server", () => {
        const perms = makePerms({ allow: [{ category: "mcp__github__*", pattern: "*" }] });
        expect(checkPermission("mcp__gitlab__create_issue", {}, perms).decision).toBe("ask");
    });

    test("specific tool rule matches only that tool", () => {
        const perms = makePerms({ allow: [{ category: "mcp__github__create_issue", pattern: "*" }] });
        expect(checkPermission("mcp__github__create_issue", {}, perms).decision).toBe("allow");
        expect(checkPermission("mcp__github__list_prs", {}, perms).decision).toBe("ask");
    });

    test("tool-segment wildcard matches get_* tools", () => {
        const perms = makePerms({ allow: [{ category: "mcp__github__get_*", pattern: "*" }] });
        expect(checkPermission("mcp__github__get_issue", {}, perms).decision).toBe("allow");
        expect(checkPermission("mcp__github__create_issue", {}, perms).decision).toBe("ask");
    });

    test("global mcp__* deny blocks every MCP tool", () => {
        const perms = makePerms({ deny: [{ category: "mcp__*", pattern: "*" }] });
        expect(checkPermission("mcp__github__create_issue", {}, perms).decision).toBe("deny");
        expect(checkPermission("mcp__sentry__list_issues", {}, perms).decision).toBe("deny");
    });

    test("server name matching is literal (mcp__github does not match mcp__github_evil)", () => {
        const perms = makePerms({ allow: [{ category: "mcp__github", pattern: "*" }] });
        expect(checkPermission("mcp__github_evil__rustle", {}, perms).decision).toBe("ask");
    });

    test("deny rule takes priority over a broader allow rule", () => {
        const perms = makePerms({
            deny: [{ category: "mcp__github__delete_*", pattern: "*" }],
            allow: [{ category: "mcp__github", pattern: "*" }],
        });
        expect(checkPermission("mcp__github__delete_repo", {}, perms).decision).toBe("deny");
        expect(checkPermission("mcp__github__list_prs", {}, perms).decision).toBe("allow");
    });

    test("ask rule takes priority over allow", () => {
        const perms = makePerms({
            ask: [{ category: "mcp__github__push", pattern: "*" }],
            allow: [{ category: "mcp__github", pattern: "*" }],
        });
        expect(checkPermission("mcp__github__push", {}, perms).decision).toBe("ask");
    });

    test("no matching rule defaults to ask", () => {
        const perms = makePerms({});
        expect(checkPermission("mcp__github__create_issue", {}, perms).decision).toBe("ask");
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

    test("MCP allow rules parsed from claude settings drive checkPermission", () => {
        const config = JSON.stringify({
            permissions: {
                allow: ["mcp__github__create_issue"],
            },
        });
        const merged = parseClaudePerms(config);
        expect(checkPermission("mcp__github__create_issue", {}, merged).decision).toBe("allow");
        expect(checkPermission("mcp__github__other", {}, merged).decision).toBe("ask");
    });
});

describe("parseClaudePerms: additionalDirectories parsing", () => {
    test("parses additionalDirectories from inside permissions object", () => {
        const config = JSON.stringify({
            permissions: {
                allow: ["Bash(ls *)"],
                additionalDirectories: ["/tmp", "~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent"],
            },
        });
        const result = parseClaudePerms(config);
        expect(result.additionalDirectories).toEqual([
            "/tmp",
            "~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent",
        ]);
    });

    test("ignores top-level additionalDirectories (not in permissions)", () => {
        const config = JSON.stringify({
            additionalDirectories: ["/wrong"],
            permissions: {
                allow: ["Bash(ls *)"],
                additionalDirectories: ["/correct"],
            },
        });
        const result = parseClaudePerms(config);
        expect(result.additionalDirectories).toEqual(["/correct"]);
    });

    test("returns empty additionalDirectories when not present", () => {
        const config = JSON.stringify({
            permissions: {
                allow: ["Bash(ls *)"],
            },
        });
        const result = parseClaudePerms(config);
        expect(result.additionalDirectories).toBeUndefined();
    });
});

describe("parseOpencodePerms: external_directory parsing", () => {
    test("parses external_directory with glob patterns as additionalDirectories", () => {
        const config = JSON.stringify({
            permission: {
                external_directory: {
                    "~/projects/personal/**": "allow",
                    "/tmp/work/**": "allow",
                },
            },
        });
        const result = parseOpencodePerms(config);
        expect(result.additionalDirectories).toEqual([
            "~/projects/personal",
            "/tmp/work",
        ]);
    });

    test("only includes allowed external_directory entries", () => {
        const config = JSON.stringify({
            permission: {
                external_directory: {
                    "~/projects/**": "allow",
                    "~/private/**": "deny",
                },
            },
        });
        const result = parseOpencodePerms(config);
        expect(result.additionalDirectories).toEqual(["~/projects"]);
    });

    test("handles single-star glob patterns", () => {
        const config = JSON.stringify({
            permission: {
                external_directory: {
                    "~/projects/*": "allow",
                },
            },
        });
        const result = parseOpencodePerms(config);
        expect(result.additionalDirectories).toEqual(["~/projects"]);
    });

    test("handles paths without glob suffix", () => {
        const config = JSON.stringify({
            permission: {
                external_directory: {
                    "~/projects": "allow",
                },
            },
        });
        const result = parseOpencodePerms(config);
        expect(result.additionalDirectories).toEqual(["~/projects"]);
    });

    test("returns undefined additionalDirectories when not present", () => {
        const config = JSON.stringify({
            permission: {
                bash: {
                    "ls *": "allow",
                },
            },
        });
        const result = parseOpencodePerms(config);
        expect(result.additionalDirectories).toBeUndefined();
    });
});
