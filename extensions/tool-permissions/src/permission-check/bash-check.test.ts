import { beforeAll, describe, expect, test } from "bun:test";

import { initParser } from "../../../shared/bash-parser/index";
import { parseClaudePerms } from "../permission-parsing";
import { checkPermission } from "./check";
import { makePerms } from "./test-helpers";
import { REASON_BASH_COMPLEX, REASON_BASH_PARSE_ERROR } from "./types";

// Initialize parser before all tests
beforeAll(async () => {
    await initParser();
});

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

describe("checkPermission: bash sensitive .pi/.claude paths", () => {
    const cwd = "/home/user/project";

    test("asks for cat .pi/settings.json", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "cat *" }] });
        const result = await checkPermission("bash", { command: "cat .pi/settings.json" }, perms, cwd);
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toContain("sensitive");
        }
    });

    test("asks for cat .claude/settings.json", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "cat *" }] });
        const result = await checkPermission("bash", { command: "cat .claude/settings.json" }, perms, cwd);
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toContain("sensitive");
        }
    });

    test("asks for cat nested path inside .pi", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "cat *" }] });
        const result = await checkPermission("bash", { command: "cat .pi/agent/state.json" }, perms, cwd);
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toContain("sensitive");
        }
    });

    test("allows cat on a plan file in .pi/plans", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "cat *" }] });
        const result = await checkPermission("bash", { command: "cat .pi/plans/plan.md" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("allows cat on a plan file in .claude/plans", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "cat *" }] });
        const result = await checkPermission("bash", { command: "cat .claude/plans/my-feature.md" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("allows cat on an absolute plan file path", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "cat *" }] });
        const result = await checkPermission("bash", { command: "cat /home/user/project/.pi/plans/plan.md" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("allows echo redirect into .pi/plans", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "echo *" }] });
        const result = await checkPermission("bash", { command: "echo hello > .pi/plans/plan.md" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("asks for cat on a plans-sibling path (.pi/plansfoo)", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "cat *" }] });
        const result = await checkPermission("bash", { command: "cat .pi/plansfoo/settings.json" }, perms, cwd);
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toContain("sensitive");
        }
    });

    test("allows cat on a normal path with allow rule", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "cat *" }] });
        const result = await checkPermission("bash", { command: "cat src/main.ts" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("asks for cat with absolute path inside .pi", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "cat *" }] });
        const result = await checkPermission("bash", { command: "cat /home/user/project/.pi/settings.json" }, perms, cwd);
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toContain("sensitive");
        }
    });

    test("asks for echo redirect to .pi/output.txt", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "echo *" }] });
        const result = await checkPermission("bash", { command: "echo hello > .pi/output.txt" }, perms, cwd);
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toContain("sensitive");
        }
    });

    test("allows echo redirect to a normal path", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "echo *" }] });
        const result = await checkPermission("bash", { command: "echo hello > output.txt" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("asks for cat in a piped command with .pi path", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "*" }] });
        const result = await checkPermission("bash", { command: "cat .pi/settings.json | grep key" }, perms, cwd);
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toContain("sensitive");
        }
    });

    test("asks for cat in a chained command with .claude path", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "echo *" }] });
        const result = await checkPermission("bash", { command: "echo hello && cat .claude/settings.json" }, perms, cwd);
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toContain("sensitive");
        }
    });

    test("cd into .pi is not auto-allowed", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "echo *" }] });
        const result = await checkPermission("bash", { command: "cd .pi && echo hello" }, perms, cwd);
        // cd into .pi is not auto-allowed (the target is a sensitive directory),
        // so the command chain is not auto-resolved.
        expect(result.decision).toBe("ask");
    });

    test("cd into .claude is not auto-allowed", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "echo *" }] });
        const result = await checkPermission("bash", { command: "cd .claude && echo hello" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("cat inside .pi after cd is blocked", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "cat *" }] });
        const result = await checkPermission("bash", { command: "cd .pi && cat settings.json" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("allows cd into .pi/plans and cat a plan file", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "cat *" }] });
        const result = await checkPermission("bash", { command: "cd .pi/plans && cat plan.md" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("asks for cat escaping .pi/plans after cd", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "cat *" }] });
        const result = await checkPermission("bash", { command: "cd .pi/plans && cat ../settings.json" }, perms, cwd);
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toContain("sensitive");
        }
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

    test("auto-allows `cd` into a subdir then back up to the original cwd (`cd sub && ... && cd ../..`)", async () => {
        const perms = makePerms({
            allow: [{ category: "bash", pattern: "git stash*" }, { category: "bash", pattern: "bunx tsc*" }],
        });
        const result = await checkPermission(
            "bash",
            {
                command:
                    "cd /home/user/project && git stash && cd src/components && bunx tsc --noEmit -p . ; cd ../.. && git stash pop",
            },
            perms,
            cwd,
        );
        expect(result.decision).toBe("allow");
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
