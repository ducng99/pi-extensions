import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { ExecFn } from "../src/session-context";
import { collectAllSettings, setRemoteSession } from "../src/settings-loading";

function writeFile(filePath: string, content: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
}

/** ExecFn stub that serves `cat <path>` from an in-memory map. */
function createFakeExec(files: Record<string, string>): ExecFn & { calls: string[] } {
    const calls: string[] = [];
    const exec = (async (command: string, args: string[]) => {
        calls.push([command, ...args].join(" "));
        if (command === "cat") {
            const content = files[args[0] ?? ""];
            if (content === undefined) return { stdout: "", stderr: "No such file", code: 1, killed: false };
            return { stdout: content, stderr: "", code: 0, killed: false };
        }
        return { stdout: "", stderr: "unsupported", code: 1, killed: false };
    }) as ExecFn & { calls: string[] };
    exec.calls = calls;
    return exec;
}

describe("collectAllSettings", () => {
    let tmpDir: string;
    let originalEnv: string | undefined;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-perms-test-"));
        originalEnv = process.env["PI_SUBAGENT_PERMISSIONS_FILE"];
        delete process.env["PI_SUBAGENT_PERMISSIONS_FILE"];
        process.env["HOME"] = tmpDir;
    });

    afterEach(() => {
        process.env["PI_SUBAGENT_PERMISSIONS_FILE"] = originalEnv;
    });

    test("honors PI_SUBAGENT_PERMISSIONS_FILE env var", async () => {
        const projectDir = path.join(tmpDir, "project");
        const claudeFile = path.join(projectDir, ".claude", "settings.json");
        writeFile(
            claudeFile,
            JSON.stringify({
                permissions: {
                    allow: [],
                    ask: [],
                    deny: [],
                },
            }),
        );

        const subagentFile = path.join(tmpDir, "subagent-perms.json");
        writeFile(
            subagentFile,
            JSON.stringify({
                permissions: {
                    allow: [],
                    ask: [],
                    deny: ["Edit(*)"],
                },
            }),
        );
        process.env["PI_SUBAGENT_PERMISSIONS_FILE"] = subagentFile;

        const settings = await collectAllSettings(projectDir);
        expect(settings.length).toBe(2);
        const merged = settings[settings.length - 1];
        expect(merged?.deny).toContainEqual({ category: "edit", pattern: "*" });
    });

    test("subagent permissions file is merged after user settings", async () => {
        const projectDir = path.join(tmpDir, "project");
        const claudeFile = path.join(projectDir, ".claude", "settings.json");
        writeFile(
            claudeFile,
            JSON.stringify({
                permissions: {
                    allow: ["Edit(*)"],
                    ask: [],
                    deny: [],
                },
            }),
        );

        const subagentFile = path.join(tmpDir, "subagent-perms.json");
        writeFile(
            subagentFile,
            JSON.stringify({
                permissions: {
                    allow: [],
                    ask: [],
                    deny: ["Edit(*)"],
                },
            }),
        );
        process.env["PI_SUBAGENT_PERMISSIONS_FILE"] = subagentFile;

        const settings = await collectAllSettings(projectDir);
        expect(settings.length).toBe(2);
        expect(settings[0]?.allow).toContainEqual({ category: "edit", pattern: "*" });
        expect(settings[1]?.deny).toContainEqual({ category: "edit", pattern: "*" });
    });

    test("ignores missing PI_SUBAGENT_PERMISSIONS_FILE", async () => {
        const projectDir = path.join(tmpDir, "project");
        const claudeFile = path.join(projectDir, ".claude", "settings.json");
        writeFile(
            claudeFile,
            JSON.stringify({
                permissions: {
                    allow: [],
                    ask: [],
                    deny: [],
                },
            }),
        );

        const settings = await collectAllSettings(projectDir);
        expect(settings.length).toBe(1);
        expect(settings[0]?.allow).toEqual([]);
    });

    test("subagent permissions file with .jsonc extension is parsed as JSONC", async () => {
        const projectDir = path.join(tmpDir, "project");
        const claudeFile = path.join(projectDir, ".claude", "settings.json");
        writeFile(
            claudeFile,
            JSON.stringify({
                permissions: {
                    allow: [],
                    ask: [],
                    deny: [],
                },
            }),
        );

        const subagentFile = path.join(tmpDir, "subagent-perms.jsonc");
        writeFile(
            subagentFile,
            `{
                // comments are allowed
                "permissions": {
                    "allow": [],
                    "ask": [],
                    "deny": ["Bash(*)"]
                }
            }`,
        );
        process.env["PI_SUBAGENT_PERMISSIONS_FILE"] = subagentFile;

        const settings = await collectAllSettings(projectDir);
        const merged = settings[settings.length - 1];
        expect(merged?.deny).toContainEqual({ category: "bash", pattern: "*" });
    });
});

describe("remote session settings", () => {
    let tmpDir: string;
    let originalEnv: string | undefined;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-perms-remote-"));
        originalEnv = process.env["PI_SUBAGENT_PERMISSIONS_FILE"];
        delete process.env["PI_SUBAGENT_PERMISSIONS_FILE"];
        process.env["HOME"] = tmpDir;
    });

    afterEach(() => {
        setRemoteSession(null);
        process.env["PI_SUBAGENT_PERMISSIONS_FILE"] = originalEnv;
    });

    test("fetches and merges remote project settings after local ones", async () => {
        const projectDir = path.join(tmpDir, "project");
        writeFile(
            path.join(projectDir, ".claude", "settings.json"),
            JSON.stringify({ permissions: { allow: ["Edit(src/*)"], ask: [], deny: [] } }),
        );

        const exec = createFakeExec({
            "/srv/app/.claude/settings.json": JSON.stringify({
                permissions: { allow: [], ask: [], deny: ["Bash(rm *)"], additionalDirectories: ["/srv/data"] },
            }),
            "/srv/app/.claude/settings.local.json": JSON.stringify({
                permissions: { allow: ["Bash(git *)"], ask: [], deny: [] },
            }),
        });
        setRemoteSession({ remoteCwd: "/srv/app", exec });

        const settings = await collectAllSettings(projectDir);
        expect(settings.length).toBe(2);
        expect(settings[0]?.allow).toContainEqual({ category: "edit", pattern: "src/*" });
        expect(settings[1]?.deny).toContainEqual({ category: "bash", pattern: "rm *" });
        expect(settings[1]?.allow).toContainEqual({ category: "bash", pattern: "git *" });
        expect(settings[1]?.additionalDirectories).toContainEqual("/srv/data");
    });

    test("remote settings are cached per connection", async () => {
        const projectDir = path.join(tmpDir, "project");
        const exec = createFakeExec({
            "/srv/app/.claude/settings.json": JSON.stringify({
                permissions: { allow: [], ask: [], deny: ["Bash(rm *)"] },
            }),
        });
        setRemoteSession({ remoteCwd: "/srv/app", exec });

        await collectAllSettings(projectDir);
        await collectAllSettings(projectDir);
        expect(exec.calls.filter(c => c.startsWith("cat")).length).toBe(2);
    });

    test("cache is invalidated when the session changes", async () => {
        const projectDir = path.join(tmpDir, "project");
        const exec = createFakeExec({
            "/srv/app/.claude/settings.json": JSON.stringify({
                permissions: { allow: [], ask: [], deny: ["Bash(rm *)"] },
            }),
        });
        setRemoteSession({ remoteCwd: "/srv/app", exec });
        await collectAllSettings(projectDir);

        setRemoteSession({ remoteCwd: "/srv/other", exec });
        await collectAllSettings(projectDir);
        expect(exec.calls.filter(c => c.startsWith("cat")).length).toBe(4);
    });

    test("missing remote settings files are tolerated", async () => {
        const projectDir = path.join(tmpDir, "project");
        writeFile(
            path.join(projectDir, ".claude", "settings.json"),
            JSON.stringify({ permissions: { allow: ["Edit(*)"], ask: [], deny: [] } }),
        );

        const exec = createFakeExec({});
        setRemoteSession({ remoteCwd: "/srv/app", exec });

        const settings = await collectAllSettings(projectDir);
        expect(settings.length).toBe(1);
        expect(settings[0]?.allow).toContainEqual({ category: "edit", pattern: "*" });
    });

    test("JSONC comments in remote settings are stripped", async () => {
        const projectDir = path.join(tmpDir, "project");
        const exec = createFakeExec({
            "/srv/app/.claude/settings.json": `{
                // remote deny
                "permissions": { "allow": [], "ask": [], "deny": ["Bash(*)"] }
            }`,
        });
        setRemoteSession({ remoteCwd: "/srv/app", exec });

        const settings = await collectAllSettings(projectDir);
        expect(settings[0]?.deny).toContainEqual({ category: "bash", pattern: "*" });
    });
});
