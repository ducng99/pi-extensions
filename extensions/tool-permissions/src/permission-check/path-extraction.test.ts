import { beforeAll, describe, expect, test } from "bun:test";

import { initParser } from "../../../shared/bash-parser/index";
import { checkPermission } from "./check";
import { makePerms } from "./test-helpers";

// Initialize parser before all tests
beforeAll(async () => {
    await initParser();
});

describe("checkPermission: regex patterns that look like paths (grep/rg/sed/awk)", () => {
    const cwd = "/home/user/project";

    test("grep pattern starting with / is not treated as a path", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "grep *" }] });
        const result = await checkPermission("bash", { command: "grep '/etc/passwd' src/main.ts" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("sed script starting with / is not treated as a path", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "sed *" }] });
        const result = await checkPermission("bash", { command: "sed '/etc/passwd/d' src/main.ts" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("rg pattern starting with / is not treated as a path", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "rg *" }] });
        const result = await checkPermission("bash", { command: "rg '/tmp/secret' src" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("grep -e pattern starting with / is not treated as a path", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "grep *" }] });
        const result = await checkPermission("bash", { command: "grep -e '/etc/passwd' src/main.ts" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("grep --regexp= pattern starting with / is not treated as a path", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "grep *" }] });
        const result = await checkPermission("bash", { command: "grep --regexp='/etc/passwd' src/main.ts" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("sed -e script starting with / is not treated as a path", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "sed *" }] });
        const result = await checkPermission("bash", { command: "sed -e '/o/d' src/main.ts" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("rg -e pattern starting with / is not treated as a path", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "rg *" }] });
        const result = await checkPermission("bash", { command: "rg -e '/tmp/secret' src" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("bundled -e pattern (grep -re) is not treated as a path", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "grep *" }] });
        const result = await checkPermission("bash", { command: "grep -re /etc/ src" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("grep with multiple -e patterns skips all pattern values", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "grep *" }] });
        const result = await checkPermission("bash", { command: "grep -e foo -e /var/log src/main.ts" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("grep real file arguments are still bounds-checked", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "grep *" }] });
        const result = await checkPermission("bash", { command: "grep foo /etc/passwd" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("grep with -e treats all positionals as files", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "grep *" }] });
        const result = await checkPermission("bash", { command: "grep -e foo /etc/passwd" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("grep pattern file (-f) is still bounds-checked", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "grep *" }] });
        const result = await checkPermission("bash", { command: "grep -f /etc/patterns src/main.ts" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("rg --files has no pattern slot: positionals are paths", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "rg *" }] });
        const result = await checkPermission("bash", { command: "rg --files /etc/passwd" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("awk program starting with / is not treated as a path", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "awk *" }] });
        const result = await checkPermission("bash", { command: "awk '/etc/passwd/ {print $1}' src/main.ts" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("gawk program starting with / is not treated as a path", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "gawk *" }] });
        const result = await checkPermission("bash", { command: "gawk '/etc/hosts/ {print}' src/main.ts" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("awk -e program starting with / is not treated as a path", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "awk *" }] });
        const result = await checkPermission("bash", { command: "awk -e '/etc/hosts/ {print}' src/main.ts" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("awk -F separate value is skipped, not treated as the pattern", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "awk *" }] });
        const result = await checkPermission("bash", { command: "awk -F : '/etc/hosts/ {print}' src/main.ts" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("awk -v value is skipped, not treated as the pattern", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "awk *" }] });
        const result = await checkPermission("bash", { command: "awk -v RS=/etc/passwd '/x/{print}' src/main.ts" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("awk real file arguments are still bounds-checked", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "awk *" }] });
        const result = await checkPermission("bash", { command: "awk '{print}' /etc/passwd" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("awk -F: attached value: file args are still bounds-checked", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "awk *" }] });
        const result = await checkPermission("bash", { command: "awk -F: '{print $1}' /etc/passwd" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("awk program file (-f) is still bounds-checked", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "awk *" }] });
        const result = await checkPermission("bash", { command: "awk -f /etc/script.awk src/main.ts" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("grep files after the pattern are still bounds-checked", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "grep *" }] });
        const result = await checkPermission("bash", { command: "grep foo src/main.ts /etc/passwd" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("grep pattern with in-bounds files is allowed", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "grep *" }] });
        const result = await checkPermission(
            "bash",
            { command: "grep '/etc/passwd' src/main.ts src/other.ts" },
            perms,
            cwd,
        );
        expect(result.decision).toBe("allow");
    });

    test("non-pattern commands still treat absolute args as paths", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "cat *" }] });
        const result = await checkPermission("bash", { command: "cat /etc/passwd" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });
});
