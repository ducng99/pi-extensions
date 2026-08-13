import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { initParser } from "../../shared/bash-parser/index";
import type { PermissionDecision } from "../src/permission-check";
import { checkPermission, isOutOfBounds, REASON_BASH_COMPLEX, REASON_BASH_PARSE_ERROR } from "../src/permission-check";
import type { ParsedPermissions } from "../src/permission-parsing";
import { parseClaudePerms } from "../src/permission-parsing";

// The real classifier (`../src/classifier.ts`) queries a model server over the
// network, so it is replaced with a controllable mock for this whole file.
// `mock.module` overwrites the exports of the already-loaded module and
// permission-check's live binding picks up the replacement (see
// `_scratch.test.ts`).
const classifyMock = mock(
    async (command: string, signal?: AbortSignal): Promise<PermissionDecision> => {
        // Fail loudly if a test triggers classification without opting in via
        // `mockImplementation` (the automode suite's beforeEach opts in).
        throw new Error(`Unexpected classifier call: ${command}${signal ? " (with signal)" : ""}`);
    },
);

mock.module("../src/classifier.ts", () => ({
    classifyBashCommand: classifyMock,
}));

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
    test("denies `sleep 1; cat .env | echo` when `cat .env` is denied", async () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "cat .env" }] });
        const result = await checkPermission("bash", { command: "sleep 1; cat .env | echo" }, perms);
        expect(result.decision).toBe("deny");
    });

    test("denies when denied command is in a pipe", async () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "cat .env" }] });
        const result = await checkPermission("bash", { command: "cat .env | grep SECRET" }, perms);
        expect(result.decision).toBe("deny");
    });

    test("denies when denied command is in &&", async () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "cat .env" }] });
        const result = await checkPermission("bash", { command: "echo hello && cat .env" }, perms);
        expect(result.decision).toBe("deny");
    });

    test("denies when denied command is in ||", async () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "cat .env" }] });
        const result = await checkPermission("bash", { command: "false || cat .env" }, perms);
        expect(result.decision).toBe("deny");
    });

    test("denies when denied command is in a subshell", async () => {
    // Subshells are kept as complex top-level commands; the deny rule must
    // match the whole subshell command string.
        const perms = makePerms({ deny: [{ category: "bash", pattern: "(cat .env)*" }] });
        const result = await checkPermission("bash", { command: "(cat .env) | grep key" }, perms);
        expect(result.decision).toBe("deny");
    });

    test("asks when denied command is in command substitution", async () => {
    // Command substitutions are complex; only whole-command deny rules apply.
        const perms = makePerms({ deny: [{ category: "bash", pattern: "cat .env" }] });
        const result = await checkPermission("bash", { command: "echo $(cat .env)" }, perms);
        expect(result.decision).toBe("ask");
    });

    test("allows when all sub-commands match allow rules", async () => {
        const perms = makePerms({
            allow: [
                { category: "bash", pattern: "echo *" },
                { category: "bash", pattern: "ls *" },
            ],
        });
        const result = await checkPermission("bash", { command: "echo hello; ls -la" }, perms);
        expect(result.decision).toBe("allow");
    });

    test("asks when some sub-commands don't match any rule", async () => {
        const perms = makePerms({
            allow: [{ category: "bash", pattern: "echo *" }],
        });
        const result = await checkPermission("bash", { command: "echo hello; cat .env" }, perms);
        expect(result.decision).toBe("ask");
    });

    test("asks on complex commands (heredoc)", async () => {
        const perms = makePerms({
            deny: [{ category: "bash", pattern: "cat" }],
        });
        const result = await checkPermission("bash", { command: "cat <<EOF\nhello\nEOF" }, perms);
        expect(result.decision).toBe("ask");
    });

    test("asks on complex commands (process substitution)", async () => {
        const perms = makePerms({
            deny: [{ category: "bash", pattern: "cat .env" }],
        });
        const result = await checkPermission("bash", { command: "diff <(cat .env) <(cat .env.bak)" }, perms);
        expect(result.decision).toBe("ask");
    });

    test("deny takes priority: one denied sub-command overrides others being allowed", async () => {
        const perms = makePerms({
            deny: [{ category: "bash", pattern: "cat .env" }],
            allow: [{ category: "bash", pattern: "echo *" }],
        });
        const result = await checkPermission("bash", { command: "echo hello; cat .env" }, perms);
        expect(result.decision).toBe("deny");
    });

    test("asks when command substitution is present", async () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "cat *" }] });
        const result = await checkPermission("bash", { command: "echo $(cat .env)" }, perms);
        expect(result.decision).toBe("ask");
    });

    test("catch-all deny pattern * denies everything", async () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "*" }] });
        const result = await checkPermission("bash", { command: "echo hello; ls -la" }, perms);
        expect(result.decision).toBe("deny");
    });

    test("find -exec is a complex top-level command", async () => {
    // find -exec is kept as a single complex command; the deny rule must match
    // the whole command string.
        const perms = makePerms({ deny: [{ category: "bash", pattern: "find *" }] });
        const result = await checkPermission("bash", { command: "find . -name '*.tmp' -exec rm {} \\;" }, perms);
        expect(result.decision).toBe("deny");
    });
});

describe("checkPermission: non-bash tools unchanged", () => {
    test("read tool still works normally", async () => {
        const perms = makePerms({ deny: [{ category: "read", pattern: ".env" }] });
        const result = await checkPermission("read", { path: ".env" }, perms);
        expect(result.decision).toBe("deny");
    });

    test("edit tool still works normally", async () => {
        const perms = makePerms({ allow: [{ category: "edit", pattern: "src/*" }] });
        const result = await checkPermission("edit", { file_path: "src/main.ts" }, perms);
        expect(result.decision).toBe("allow");
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

describe("checkPermission: bash redirection patterns", () => {
    test("allow `bun test *` permits `bun test 2>&1`", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "bun test *" }] });
        const result = await checkPermission("bash", { command: "bun test 2>&1" }, perms);
        expect(result.decision).toBe("allow");
    });

    test("allow `bun test *` permits `bun test --coverage 2>&1`", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "bun test *" }] });
        const result = await checkPermission("bash", { command: "bun test --coverage 2>&1" }, perms);
        expect(result.decision).toBe("allow");
    });

    test("allow `bun test *` permits `bun test > output.txt`", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "bun test *" }] });
        const result = await checkPermission("bash", { command: "bun test > output.txt" }, perms);
        expect(result.decision).toBe("allow");
    });

    test("deny `rm *` catches `rm file.txt 2>/dev/null`", async () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "rm *" }] });
        const result = await checkPermission("bash", { command: "rm file.txt 2>/dev/null" }, perms);
        expect(result.decision).toBe("deny");
    });
});

describe("checkPermission: bash out-of-bounds paths", () => {
    const cwd = "/home/user/project";

    test("allows commands with paths inside cwd", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "cat *" }] });
        const result = await checkPermission("bash", { command: "cat src/main.ts" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("asks for commands with absolute paths outside cwd", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "cat *" }] });
        const result = await checkPermission("bash", { command: "cat /etc/passwd" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("asks for commands with relative paths outside cwd", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "cat *" }] });
        const result = await checkPermission("bash", { command: "cat ../../../etc/passwd" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("allows commands with paths in additional directories", async () => {
        const perms = makePerms({
            allow: [{ category: "bash", pattern: "cat *" }],
        });
        perms.additionalDirectories = ["/home/user/shared"];
        const result = await checkPermission("bash", { command: "cat /home/user/shared/file.txt" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("allows commands with relative paths to additional directories", async () => {
        const perms = makePerms({
            allow: [{ category: "bash", pattern: "cat *" }],
        });
        perms.additionalDirectories = ["../shared"];
        const result = await checkPermission("bash", { command: "cat ../shared/file.txt" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("asks for commands with paths outside cwd and additional dirs", async () => {
        const perms = makePerms({
            allow: [{ category: "bash", pattern: "cat *" }],
        });
        perms.additionalDirectories = ["/home/user/shared"];
        const result = await checkPermission("bash", { command: "cat /home/user/other/file.txt" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("allows commands with no paths", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "echo *" }] });
        const result = await checkPermission("bash", { command: "echo hello" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("allows commands with flags but no paths", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "ls *" }] });
        const result = await checkPermission("bash", { command: "ls -la --color" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("asks for commands with ./ paths outside cwd", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "cat *" }] });
        const result = await checkPermission("bash", { command: "cat ./src/main.ts" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("deny still takes priority over out-of-bounds", async () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "cat *" }] });
        const result = await checkPermission("bash", { command: "cat /etc/passwd" }, perms, cwd);
        expect(result.decision).toBe("deny");
    });

    test("checks paths in sub-commands", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "*" }] });
        const result = await checkPermission("bash", { command: "echo $(cat /etc/passwd)" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("checks paths in piped commands", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "*" }] });
        const result = await checkPermission("bash", { command: "cat /etc/passwd | grep root" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("asks for redirection to file outside cwd", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "echo *" }] });
        const result = await checkPermission("bash", { command: "echo hello > /etc/outside.txt" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("asks for append redirection to file outside cwd", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "echo *" }] });
        const result = await checkPermission("bash", { command: "echo hello >> /etc/outside.txt" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("asks for stderr redirection to file outside cwd", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "bun test *" }] });
        const result = await checkPermission("bash", { command: "bun test 2> /tmp/errors.log" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("asks for combined output redirection to file outside cwd", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "bun test *" }] });
        const result = await checkPermission("bash", { command: "bun test &> /tmp/all.log" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("allows redirection to file inside cwd", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "echo *" }] });
        const result = await checkPermission("bash", { command: "echo hello > output.txt" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("allows redirection to /dev/null", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "bun test *" }] });
        const result = await checkPermission("bash", { command: "bun test 2>/dev/null" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("allows fd-to-fd redirection (2>&1)", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "bun test *" }] });
        const result = await checkPermission("bash", { command: "bun test 2>&1" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("asks for redirection in piped command to file outside cwd", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "*" }] });
        const result = await checkPermission("bash", { command: "cat src/main.ts | grep TODO > /tmp/results.txt" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });
});

describe("checkPermission: bash `cd` auto-allow", () => {
    const cwd = "/home/user/project";

    test("auto-allows `cd` within cwd without explicit allow rule", async () => {
        const perms = makePerms({
            allow: [{ category: "bash", pattern: "head *" }],
        });
        const result = await checkPermission(
            "bash",
            { command: "cd /home/user/project/src && head -100 file.ts" },
            perms,
            cwd,
        );
        expect(result.decision).toBe("allow");
    });

    test("auto-allows `cd` with relative path within cwd", async () => {
        const perms = makePerms({
            allow: [{ category: "bash", pattern: "ls *" }],
        });
        const result = await checkPermission(
            "bash",
            { command: "cd src/components && ls -la" },
            perms,
            cwd,
        );
        expect(result.decision).toBe("allow");
    });

    test("auto-allows `cd` within additional directories", async () => {
        const perms = makePerms({
            allow: [{ category: "bash", pattern: "echo *" }],
        });
        perms.additionalDirectories = ["/home/user/shared"];
        const result = await checkPermission(
            "bash",
            { command: "cd /home/user/shared && echo hello" },
            perms,
            cwd,
        );
        expect(result.decision).toBe("allow");
    });

    test("asks for `cd` outside cwd and additional dirs", async () => {
        const perms = makePerms({
            allow: [{ category: "bash", pattern: "echo *" }],
        });
        const result = await checkPermission(
            "bash",
            { command: "cd /etc && echo hello" },
            perms,
            cwd,
        );
        expect(result.decision).toBe("ask");
    });

    test("asks for `cd` with relative path escaping cwd", async () => {
        const perms = makePerms({
            allow: [{ category: "bash", pattern: "echo *" }],
        });
        const result = await checkPermission(
            "bash",
            { command: "cd ../../../etc && echo hello" },
            perms,
            cwd,
        );
        expect(result.decision).toBe("ask");
    });

    test("deny rule still takes priority over cd auto-allow", async () => {
        const perms = makePerms({
            deny: [{ category: "bash", pattern: "cd /etc*" }],
            allow: [{ category: "bash", pattern: "echo *" }],
        });
        const result = await checkPermission(
            "bash",
            { command: "cd /etc && echo hello" },
            perms,
            cwd,
        );
        expect(result.decision).toBe("deny");
    });

    test("auto-allows `cd` with flags like -P", async () => {
        const perms = makePerms({
            allow: [{ category: "bash", pattern: "echo *" }],
        });
        const result = await checkPermission(
            "bash",
            { command: "cd -P /home/user/project/src && echo hello" },
            perms,
            cwd,
        );
        expect(result.decision).toBe("allow");
    });

    test("does not auto-allow `cd` without a path argument", async () => {
        const perms = makePerms({
            allow: [{ category: "bash", pattern: "echo *" }],
        });
        const result = await checkPermission(
            "bash",
            { command: "cd && echo hello" },
            perms,
            cwd,
        );
        // `cd` alone with no arg doesn't match isCdInBounds, so it asks
        expect(result.decision).toBe("ask");
    });

    test("`cd` updates effective cwd for subsequent relative paths", async () => {
        const perms = makePerms({
            allow: [{ category: "bash", pattern: "bun build *" }],
        });
        perms.additionalDirectories = ["/tmp"];
        const result = await checkPermission(
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
    test("deny rule can match whole complex heredoc command", async () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "cat <<EOF*" }] });
        const result = await checkPermission("bash", { command: "cat <<EOF\nhello\nEOF" }, perms);
        expect(result.decision).toBe("deny");
    });

    test("deny rule can match whole complex process substitution command", async () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "diff *" }] });
        const result = await checkPermission("bash", { command: "diff <(cat .env) <(cat .env.bak)" }, perms);
        expect(result.decision).toBe("deny");
    });

    test("deny rule with wildcard matches complex heredoc command", async () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "cat *" }] });
        const result = await checkPermission("bash", { command: "cat <<EOF\nhello\nEOF" }, perms);
        expect(result.decision).toBe("deny");
    });

    test("unparseable command falls back to ask", async () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "echo *" }] });
        const result = await checkPermission("bash", { command: "echo \"unterminated" }, perms);
        expect(result.decision).toBe("ask");
    });

    test("asks with a reason when the command is too complex", async () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "cat .env" }] });
        const result = await checkPermission("bash", { command: "cat <<EOF\nhello\nEOF" }, perms);
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toBeDefined();
            expect(result.reason).toStrictEqual(REASON_BASH_COMPLEX);
        }
    });

    test("asks with a reason when the command fails to parse", async () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "echo *" }] });
        const result = await checkPermission("bash", { command: "echo \"unterminated" }, perms);
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toBeDefined();
            expect(result.reason).toStrictEqual(REASON_BASH_PARSE_ERROR);
        }
    });

    test("plain ask decisions have no reason", async () => {
        const perms = makePerms({});
        const result = await checkPermission("bash", { command: "curl https://example.com" }, perms);
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toBeUndefined();
        }
    });

    test("non-bash ask decisions have no reason", async () => {
        const perms = makePerms({ ask: [{ category: "unknown_tool", pattern: "*" }] });
        const result = await checkPermission("unknown_tool", {}, perms);
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
    test("bare server rule allows every tool on that server", async () => {
        const perms = makePerms({ allow: [{ category: "mcp__github", pattern: "*" }] });
        expect((await checkPermission("mcp__github__create_issue", {}, perms)).decision).toBe("allow");
        expect((await checkPermission("mcp__github__list_prs", {}, perms)).decision).toBe("allow");
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

describe("checkPermission: automode classifier integration", () => {
    const cwd = "/home/user/project";

    beforeEach(() => {
        classifyMock.mockClear();
        classifyMock.mockImplementation(
            async (): Promise<PermissionDecision> => ({ decision: "allow" }),
        );
    });

    test("automode on: classifier allow resolves an unresolved command", async () => {
        const perms = makePerms({});
        const result = await checkPermission(
            "bash",
            { command: "curl https://example.com" },
            perms,
            undefined,
            () => true,
        );
        expect(result.decision).toBe("allow");
        expect(classifyMock).toHaveBeenCalledTimes(1);
        expect(classifyMock.mock.calls[0]![0]).toBe("curl https://example.com");
    });

    test("automode on: classifier ask is returned with its reason", async () => {
        const reason = "Auto mode threshold not met: 0.80 (lower = safer)";
        classifyMock.mockImplementation(
            async (): Promise<PermissionDecision> => ({ decision: "ask", reason }),
        );
        const perms = makePerms({});
        const result = await checkPermission(
            "bash",
            { command: "curl https://example.com" },
            perms,
            undefined,
            () => true,
        );
        expect(result).toEqual({ decision: "ask", reason });
        expect(classifyMock).toHaveBeenCalledTimes(1);
    });

    test("automode on: classifier deny is returned", async () => {
        classifyMock.mockImplementation(
            async (): Promise<PermissionDecision> => ({ decision: "deny" }),
        );
        const perms = makePerms({});
        const result = await checkPermission(
            "bash",
            { command: "curl https://example.com" },
            perms,
            undefined,
            () => true,
        );
        expect(result.decision).toBe("deny");
    });

    test("automode off: classifier is never consulted", async () => {
        const perms = makePerms({});
        const result = await checkPermission("bash", { command: "curl https://example.com" }, perms);
        expect(result.decision).toBe("ask");
        expect(classifyMock).not.toHaveBeenCalled();
    });

    test("automode on: deny rule takes priority over classifier", async () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "curl *" }] });
        const result = await checkPermission(
            "bash",
            { command: "curl https://example.com" },
            perms,
            undefined,
            () => true,
        );
        expect(result.decision).toBe("deny");
        expect(classifyMock).not.toHaveBeenCalled();
    });

    test("automode on: ask rule takes priority over classifier", async () => {
        const perms = makePerms({ ask: [{ category: "bash", pattern: "curl *" }] });
        const result = await checkPermission(
            "bash",
            { command: "curl https://example.com" },
            perms,
            undefined,
            () => true,
        );
        expect(result.decision).toBe("ask");
        expect(classifyMock).not.toHaveBeenCalled();
    });

    test("automode on: allow rule match skips classifier", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "curl *" }] });
        const result = await checkPermission(
            "bash",
            { command: "curl https://example.com" },
            perms,
            undefined,
            () => true,
        );
        expect(result.decision).toBe("allow");
        expect(classifyMock).not.toHaveBeenCalled();
    });

    test("automode on: out-of-bounds takes priority over classifier", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "cat *" }] });
        const result = await checkPermission(
            "bash",
            { command: "cat /etc/passwd" },
            perms,
            cwd,
            () => true,
        );
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toContain("outside allowed directories");
        }
        expect(classifyMock).not.toHaveBeenCalled();
    });

    test("automode on: default-allowed command skips classifier", async () => {
        const perms = makePerms({});
        const result = await checkPermission(
            "bash",
            { command: "echo hello" },
            perms,
            undefined,
            () => true,
        );
        expect(result.decision).toBe("allow");
        expect(classifyMock).not.toHaveBeenCalled();
    });

    test("automode on: cd auto-allow skips classifier", async () => {
        const perms = makePerms({});
        const result = await checkPermission(
            "bash",
            { command: "cd /home/user/project/src" },
            perms,
            cwd,
            () => true,
        );
        expect(result.decision).toBe("allow");
        expect(classifyMock).not.toHaveBeenCalled();
    });

    test("automode on: classifier receives the whole command when any sub-command is unresolved", async () => {
        const perms = makePerms({});
        const result = await checkPermission(
            "bash",
            { command: "echo hello; curl https://example.com" },
            perms,
            undefined,
            () => true,
        );
        // `echo hello` resolves via default-allowed, but `curl` is unresolved, so
        // the classifier is consulted once with the WHOLE command string.
        expect(result.decision).toBe("allow");
        expect(classifyMock).toHaveBeenCalledTimes(1);
        expect(classifyMock.mock.calls[0]![0]).toBe("echo hello; curl https://example.com");
    });

    test("automode on: classifier receives the abort signal", async () => {
        const controller = new AbortController();
        const perms = makePerms({});
        await checkPermission(
            "bash",
            { command: "curl https://example.com" },
            perms,
            undefined,
            () => true,
            controller.signal,
        );
        expect(classifyMock).toHaveBeenCalledTimes(1);
        expect(classifyMock.mock.calls[0]![1]).toBe(controller.signal);
    });

    test("automode on: complex command is classified with the full command string", async () => {
        const reason = "Auto mode threshold not met: 0.80 (lower = safer)";
        classifyMock.mockImplementation(
            async (): Promise<PermissionDecision> => ({ decision: "ask", reason }),
        );
        const perms = makePerms({});
        const result = await checkPermission(
            "bash",
            { command: "echo $(curl https://example.com)" },
            perms,
            undefined,
            () => true,
        );
        expect(result).toEqual({ decision: "ask", reason });
        expect(classifyMock).toHaveBeenCalledTimes(1);
        expect(classifyMock.mock.calls[0]![0]).toBe("echo $(curl https://example.com)");
    });

    test("automode on: complex command allowed by classifier falls through to normal checks", async () => {
        const perms = makePerms({});
        const result = await checkPermission(
            "bash",
            { command: "echo $(curl https://example.com)" },
            perms,
            undefined,
            () => true,
        );
        // Classifier says allow → fall through; `echo` is default-allowed.
        expect(result.decision).toBe("allow");
        expect(classifyMock).toHaveBeenCalledTimes(1);
        expect(classifyMock.mock.calls[0]![0]).toBe("echo $(curl https://example.com)");
    });

    test("automode on: complex command is classified with the full raw command string", async () => {
        const perms = makePerms({});
        const result = await checkPermission(
            "bash",
            { command: "cat <<EOF\nhello\nEOF" },
            perms,
            undefined,
            () => true,
        );
        // The complex heredoc command is classified once with the full raw
        // command string; `cat` is not default-allowed so classification
        // decides the outcome.
        expect(result.decision).toBe("allow");
        expect(classifyMock).toHaveBeenCalledTimes(1);
        expect(classifyMock.mock.calls[0]![0]).toBe("cat <<EOF\nhello\nEOF");
    });

    test("automode on: parse errors ask without consulting classifier", async () => {
        const perms = makePerms({});
        const result = await checkPermission(
            "bash",
            { command: "echo \"unterminated" },
            perms,
            undefined,
            () => true,
        );
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toStrictEqual(REASON_BASH_PARSE_ERROR);
        }
        expect(classifyMock).not.toHaveBeenCalled();
    });

    test("automode off: complex command still asks without classifier", async () => {
        const perms = makePerms({});
        const result = await checkPermission("bash", { command: "cat <<EOF\nhello\nEOF" }, perms);
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toStrictEqual(REASON_BASH_COMPLEX);
        }
        expect(classifyMock).not.toHaveBeenCalled();
    });
});
