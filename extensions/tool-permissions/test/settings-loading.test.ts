import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { collectAllSettings } from "../src/settings-loading";

function writeFile(filePath: string, content: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
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

    test("honors PI_SUBAGENT_PERMISSIONS_FILE env var", () => {
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

        const settings = collectAllSettings(projectDir);
        expect(settings.length).toBe(2);
        const merged = settings[settings.length - 1];
        expect(merged?.deny).toContainEqual({ category: "edit", pattern: "*" });
    });

    test("subagent permissions file is merged after user settings", () => {
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

        const settings = collectAllSettings(projectDir);
        expect(settings.length).toBe(2);
        expect(settings[0]?.allow).toContainEqual({ category: "edit", pattern: "*" });
        expect(settings[1]?.deny).toContainEqual({ category: "edit", pattern: "*" });
    });

    test("ignores missing PI_SUBAGENT_PERMISSIONS_FILE", () => {
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

        const settings = collectAllSettings(projectDir);
        expect(settings.length).toBe(1);
        expect(settings[0]?.allow).toEqual([]);
    });

    test("subagent permissions file with .jsonc extension is parsed as JSONC", () => {
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

        const settings = collectAllSettings(projectDir);
        const merged = settings[settings.length - 1];
        expect(merged?.deny).toContainEqual({ category: "bash", pattern: "*" });
    });
});
