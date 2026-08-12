import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { PLAN_MODE_PERMISSIONS } from "../../plan/tools";
import { initParser } from "../../shared/bash-parser/index";
import { checkPermission } from "../src/permission-check";
import type { ParsedPermissions } from "../src/permission-parsing";
import { collectAllSettings, mergePermissions, setPlanModePermissions } from "../src/settings-loading";

// Initialize parser before all tests (tree-sitter is required for bash checks).
beforeAll(async () => {
    await initParser();
});

function emptyPerms(): ParsedPermissions {
    return { allow: [], ask: [], deny: [], additionalDirectories: [] };
}

describe("plan-mode permission set (deny-focused)", () => {
    test("edit and write tools are denied in plan mode", async () => {
        expect((await checkPermission("edit", { path: "./a.ts", edits: [] }, PLAN_MODE_PERMISSIONS, "/cwd")).decision)
            .toBe("deny");
        expect((await checkPermission("write", { path: "./new.txt", content: "x" }, PLAN_MODE_PERMISSIONS, "/cwd")).decision)
            .toBe("deny");
    });

    test("filesystem mutators are denied in plan mode", async () => {
        for (const cmd of ["rm -rf dist", "mv a b", "cp a b", "touch x", "mkdir x", "chmod +x a", "tee out.txt"]) {
            expect((await checkPermission("bash", { command: cmd }, PLAN_MODE_PERMISSIONS, "/cwd")).decision, cmd)
                .toBe("deny");
        }
    });

    test("version control and package manager mutations are denied", async () => {
        for (const cmd of ["git add .", "git commit -m x", "git push", "npm install", "bun run build", "make"]) {
            expect((await checkPermission("bash", { command: cmd }, PLAN_MODE_PERMISSIONS, "/cwd")).decision, cmd)
                .toBe("deny");
        }
    });

    test("compound bash with a denied sub-command is blocked", async () => {
        expect((await checkPermission("bash", { command: "cat a && rm b" }, PLAN_MODE_PERMISSIONS, "/cwd")).decision)
            .toBe("deny");
    });

    test("read-only bash commands are not denied (fall through to defaults/settings)", async () => {
        for (const cmd of ["cat file.txt", "grep foo file.txt", "ls -la", "head a b"]) {
            expect((await checkPermission("bash", { command: cmd }, PLAN_MODE_PERMISSIONS, "/cwd")).decision, cmd)
                .not.toBe("deny");
        }
    });

    test("plan-mode deny rules take precedence over a user allow (defense in depth)", async () => {
        // User settings allow edit — but plan mode denies it, so merged result denies.
        const userSettings = {
            allow: [{ category: "edit", pattern: "*" }],
            ask: [],
            deny: [],
            additionalDirectories: [],
        };
        const merged = mergePermissions([userSettings, PLAN_MODE_PERMISSIONS]);
        expect((await checkPermission("edit", { path: "./a.ts", edits: [] }, merged, "/cwd")).decision).toBe("deny");
    });
});

describe("settings-loading: plan-mode permissions merged like the subagent file", () => {
    let dir: string;

    afterEach(async () => {
        setPlanModePermissions(null);
    });

    test("collectAllSettings includes plan-mode permissions when set", async () => {
        dir = await mkdtemp(join(tmpdir(), "plan-mode-sh-"));
        setPlanModePermissions(PLAN_MODE_PERMISSIONS);

        const merged = mergePermissions(collectAllSettings(dir));
        // Plan-mode deny rules must be present in the merged set.
        expect(merged.deny.some(r => r.category === "edit" && r.pattern === "*")).toBe(true);
        expect(merged.deny.some(r => r.category === "bash" && r.pattern === "rm *")).toBe(true);
    });

    test("clearPlanModePermissions removes plan-mode rules", async () => {
        dir = await mkdtemp(join(tmpdir(), "plan-mode-sh-"));
        setPlanModePermissions(PLAN_MODE_PERMISSIONS);
        setPlanModePermissions(null);

        const merged = mergePermissions(collectAllSettings(dir));
        expect(merged.deny.some(r => r.category === "bash" && r.pattern === "rm *")).toBe(false);
    });

    test("deactivated plan mode leaves edit/write to default 'ask' (not denied)", async () => {
        expect((await checkPermission("edit", { path: "./a", edits: [] }, emptyPerms(), "/cwd")).decision).toBe("ask");
        expect((await checkPermission("bash", { command: "rm file" }, emptyPerms(), "/cwd")).decision).toBe("ask");
    });
});
