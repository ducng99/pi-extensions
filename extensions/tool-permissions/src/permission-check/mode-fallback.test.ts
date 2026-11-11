import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { initParser } from "../../../shared/bash-parser/index";
import { checkPermission } from "./check";
import { classifyMock, makePerms } from "./test-helpers";
import type { PermissionDecision } from "./types";
import { REASON_AUTO_MODE_DENIED, REASON_BASH_COMPLEX, REASON_BASH_PARSE_ERROR } from "./types";

// Initialize parser before all tests
beforeAll(async () => {
    await initParser();
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
            () => "auto",
        );
        expect(result.decision).toBe("allow");
        expect(classifyMock).toHaveBeenCalledTimes(1);
        expect(classifyMock.mock.calls[0]![0]).toBe("bash");
        expect(classifyMock.mock.calls[0]![1]).toMatchObject({ command: "curl https://example.com" });
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
            () => "auto",
        );
        expect(result).toEqual({ decision: "ask", reason });
        expect(classifyMock).toHaveBeenCalledTimes(1);
    });

    test("automode on: classifier deny uses a fixed reason and notifies the classifier reason", async () => {
        const classifierReason = "Auto mode (label=deny, score=0.95)";
        classifyMock.mockImplementation(
            async (): Promise<PermissionDecision> => ({ decision: "deny", reason: classifierReason }),
        );
        const perms = makePerms({});
        const result = await checkPermission(
            "bash",
            { command: "curl https://example.com" },
            perms,
            undefined,
            () => "auto",
        );
        expect(result.decision).toBe("deny");
        expect(result.reason).toBe(REASON_AUTO_MODE_DENIED);
        expect(result.notify).toBe(classifierReason);
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
            () => "auto",
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
            () => "auto",
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
            () => "auto",
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
            () => "auto",
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
            () => "auto",
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
            () => "auto",
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
            () => "auto",
        );
        // `echo hello` resolves via default-allowed, but `curl` is unresolved, so
        // the classifier is consulted once with the WHOLE command string.
        expect(result.decision).toBe("allow");
        expect(classifyMock.mock.calls[0]![0]).toBe("bash");
        expect(classifyMock.mock.calls[0]![1]).toMatchObject({ command: "echo hello; curl https://example.com" });
    });

    test("automode on: classifier receives the abort signal", async () => {
        const controller = new AbortController();
        const perms = makePerms({});
        await checkPermission(
            "bash",
            { command: "curl https://example.com" },
            perms,
            undefined,
            () => "auto",
            controller.signal,
        );
        expect(classifyMock.mock.calls[0]![2]).toBe(controller.signal);
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
            () => "auto",
        );
        expect(result).toEqual({ decision: "ask", reason });
        expect(classifyMock.mock.calls[0]![0]).toBe("bash");
        expect(classifyMock.mock.calls[0]![1]).toMatchObject({ command: "echo $(curl https://example.com)" });
    });

    test("automode on: complex command allowed by classifier falls through to normal checks", async () => {
        const perms = makePerms({});
        const result = await checkPermission(
            "bash",
            { command: "echo $(curl https://example.com)" },
            perms,
            undefined,
            () => "auto",
        );
        // Classifier says allow → fall through; `echo` is default-allowed.
        expect(result.decision).toBe("allow");
        expect(classifyMock.mock.calls[0]![0]).toBe("bash");
        expect(classifyMock.mock.calls[0]![1]).toMatchObject({ command: "echo $(curl https://example.com)" });
    });

    test("automode on: complex command is classified with the full raw command string", async () => {
        const perms = makePerms({});
        const result = await checkPermission(
            "bash",
            { command: "cat <<EOF\nhello\nEOF" },
            perms,
            undefined,
            () => "auto",
        );
        // The complex heredoc command is classified once with the full raw
        // command string; `cat` is not default-allowed so classification
        // decides the outcome.
        expect(result.decision).toBe("allow");
        expect(classifyMock.mock.calls[0]![0]).toBe("bash");
        expect(classifyMock.mock.calls[0]![1]).toMatchObject({ command: "cat <<EOF\nhello\nEOF" });
    });

    test("automode on: parse errors ask without consulting classifier", async () => {
        const perms = makePerms({});
        const result = await checkPermission(
            "bash",
            { command: "echo \"unterminated" },
            perms,
            undefined,
            () => "auto",
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

describe("checkPermission: allow mode fallback", () => {
    const cwd = "/home/user/project";

    beforeEach(() => {
        classifyMock.mockClear();
        // Fail loudly if allow mode ever reaches the classifier.
        classifyMock.mockImplementation(
            async (): Promise<PermissionDecision> => {
                throw new Error("classifier must not be consulted in allow mode");
            },
        );
    });

    test("allow mode: unresolved bash command defaults to allow", async () => {
        const perms = makePerms({});
        const result = await checkPermission("bash", { command: "curl https://example.com" }, perms, undefined, () => "allow");
        expect(result.decision).toBe("allow");
        expect(classifyMock).not.toHaveBeenCalled();
    });

    test("allow mode: unresolved sub-command in a chain defaults to allow", async () => {
        const perms = makePerms({});
        const result = await checkPermission(
            "bash",
            { command: "echo hello; curl https://example.com" },
            perms,
            undefined,
            () => "allow",
        );
        expect(result.decision).toBe("allow");
        expect(classifyMock).not.toHaveBeenCalled();
    });

    test("allow mode: complex command defaults to allow", async () => {
        const perms = makePerms({});
        const result = await checkPermission(
            "bash",
            { command: "echo $(curl https://example.com)" },
            perms,
            undefined,
            () => "allow",
        );
        expect(result.decision).toBe("allow");
        expect(classifyMock).not.toHaveBeenCalled();
    });

    test("allow mode: out-of-bounds command still asks", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "cat *" }] });
        const result = await checkPermission("bash", { command: "cat /etc/passwd" }, perms, cwd, () => "allow");
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toContain("outside allowed directories");
        }
    });

    test("allow mode: out-of-bounds cd still asks", async () => {
        const perms = makePerms({});
        const result = await checkPermission("bash", { command: "cd /etc" }, perms, cwd, () => "allow");
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toContain("outside allowed directories");
        }
    });

    test("allow mode: sensitive path still asks", async () => {
        const perms = makePerms({});
        const result = await checkPermission("bash", { command: "cat .pi/settings.json" }, perms, cwd, () => "allow");
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toContain("sensitive");
        }
    });

    test("allow mode: deny rule still denies", async () => {
        const perms = makePerms({ deny: [{ category: "bash", pattern: "curl *" }] });
        const result = await checkPermission("bash", { command: "curl https://example.com" }, perms, undefined, () => "allow");
        expect(result.decision).toBe("deny");
    });

    test("allow mode: ask rule still asks", async () => {
        const perms = makePerms({ ask: [{ category: "bash", pattern: "curl *" }] });
        const result = await checkPermission("bash", { command: "curl https://example.com" }, perms, undefined, () => "allow");
        expect(result.decision).toBe("ask");
    });

    test("allow mode: unresolved non-bash tool defaults to allow", async () => {
        const perms = makePerms({});
        const result = await checkPermission("unknown_tool", { foo: "bar" }, perms, undefined, () => "allow");
        expect(result.decision).toBe("allow");
        expect(classifyMock).not.toHaveBeenCalled();
    });

    test("allow mode: unresolved MCP tool defaults to allow", async () => {
        const perms = makePerms({});
        const result = await checkPermission("mcp__github__create_issue", {}, perms, undefined, () => "allow");
        expect(result.decision).toBe("allow");
        expect(classifyMock).not.toHaveBeenCalled();
    });

    test("allow mode: out-of-bounds file access via allow rule still asks", async () => {
        const perms = makePerms({ allow: [{ category: "edit", pattern: "*" }] });
        const result = await checkPermission("write", { path: "/etc/hosts" }, perms, cwd, () => "allow");
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toContain("outside allowed directories");
        }
    });

    test("allow mode: sensitive file access still asks", async () => {
        const perms = makePerms({});
        const result = await checkPermission("read", { path: ".claude/settings.json" }, perms, cwd, () => "allow");
        expect(result.decision).toBe("ask");
        if (result.decision === "ask") {
            expect(result.reason).toContain("sensitive");
        }
    });
});
