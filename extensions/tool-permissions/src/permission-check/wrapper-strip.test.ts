import { beforeAll, describe, expect, test } from "bun:test";

import { initParser } from "../../../shared/bash-parser/index";
import { checkPermission } from "./check";
import { makePerms } from "./test-helpers";

// Initialize parser before all tests
beforeAll(async () => {
    await initParser();
});

describe("checkPermission: bash `time` handling", () => {
    const cwd = "/home/user/project";

    test("asks for `time` wrapping an unlisted command even in automode", async () => {
        const perms = makePerms({});
        const result = await checkPermission(
            "bash",
            { command: "time .venv/bin/python /tmp/script.py" },
            perms,
            cwd,
            () => "auto",
            undefined,
            async () => ({ cwd, gitRemote: undefined, gitStatus: undefined, recentToolCalls: [], agentTouchedFiles: [] }),
            () => [],
        );
        expect(result.decision).toBe("ask");
    });

    test("allows `time` wrapping an allow-listed command via rule match on the wrapped command", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "git status*" }] });
        const result = await checkPermission("bash", { command: "time git status --short" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("allows `time` wrapping a default-allowed command", async () => {
        const perms = makePerms({});
        const result = await checkPermission("bash", { command: "time echo hello" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("deny rules apply to the wrapped command", async () => {
        const perms = makePerms({
            deny: [{ category: "bash", pattern: "perl *" }],
            allow: [{ category: "bash", pattern: "perl *" }],
        });
        const result = await checkPermission("bash", { command: "time perl -e 'print 1'" }, perms, cwd);
        expect(result.decision).toBe("deny");
    });

    test("allows bare `time` with no wrapped command", async () => {
        const perms = makePerms({});
        const result = await checkPermission("bash", { command: "time" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });
});

describe("checkPermission: bash `nohup`/`timeout` wrapper handling", () => {
    const cwd = "/home/user/project";

    test("allows `timeout <dur>` wrapping an allow-listed command", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "jq *" }] });
        const result = await checkPermission("bash", { command: "timeout 300 jq . data.json" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("supports duration units and floats", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "jq *" }] });
        for (const command of ["timeout 5m jq . data.json", "timeout 0.5s jq . data.json", "timeout 2h jq . data.json"]) {
            const result = await checkPermission("bash", { command }, perms, cwd);
            expect(result.decision).toBe("allow");
        }
    });

    test("supports timeout options before the duration", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "jq *" }] });
        const result = await checkPermission(
            "bash",
            { command: "timeout --preserve-status -k 5 -s KILL 300 jq . data.json" },
            perms,
            cwd,
        );
        expect(result.decision).toBe("allow");
    });

    test("allows `nohup` wrapping an allow-listed command", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "jq *" }] });
        const result = await checkPermission("bash", { command: "nohup jq . data.json" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("allows stacked wrappers", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "jq *" }] });
        const result = await checkPermission("bash", { command: "nohup timeout 300 jq . data.json" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("allows `timeout` wrapping a default-allowed command", async () => {
        const perms = makePerms({});
        const result = await checkPermission("bash", { command: "timeout 300 echo hello" }, perms, cwd);
        expect(result.decision).toBe("allow");
    });

    test("deny rules apply to the wrapped command", async () => {
        const perms = makePerms({
            deny: [{ category: "bash", pattern: "perl *" }],
            allow: [{ category: "bash", pattern: "perl *" }],
        });
        const result = await checkPermission("bash", { command: "timeout 300 perl -e 'print 1'" }, perms, cwd);
        expect(result.decision).toBe("deny");
    });

    test("wrapped commands are still bounds-checked", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "jq *" }] });
        const result = await checkPermission("bash", { command: "timeout 300 jq . /etc/passwd" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("redirects of wrapped commands are still bounds-checked", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "jq *" }] });
        const result = await checkPermission("bash", { command: "timeout 300 jq . > /tmp/out.json" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("asks for `timeout` wrapping an unlisted command even in automode", async () => {
        const perms = makePerms({});
        const result = await checkPermission(
            "bash",
            { command: "timeout 300 .venv/bin/python /tmp/script.py" },
            perms,
            cwd,
            () => "auto",
            undefined,
            async () => ({ cwd, gitRemote: undefined, gitStatus: undefined, recentToolCalls: [], agentTouchedFiles: [] }),
            () => [],
        );
        expect(result.decision).toBe("ask");
    });

    test("does not strip an unparseable timeout header (variable duration)", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "jq *" }] });
        const result = await checkPermission("bash", { command: "timeout $D jq . data.json" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("does not strip an unparseable timeout header (unknown option)", async () => {
        const perms = makePerms({ allow: [{ category: "bash", pattern: "jq *" }] });
        const result = await checkPermission("bash", { command: "timeout --future-flag 300 jq . data.json" }, perms, cwd);
        expect(result.decision).toBe("ask");
    });

    test("allows bare no-op wrappers with no wrapped command", async () => {
        const perms = makePerms({});
        for (const command of ["nohup", "nohup --version", "timeout --help", "timeout --version"]) {
            const result = await checkPermission("bash", { command }, perms, cwd);
            expect(result.decision).toBe("allow");
        }
    });
});
