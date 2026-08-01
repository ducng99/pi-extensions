import { describe, expect, test } from "bun:test";

import { permissionsToClaudeSettings } from "../utils";

describe("permissionsToClaudeSettings", () => {
    test("maps edit permission to Edit(*)", () => {
        const settings = permissionsToClaudeSettings({ edit: "deny" });
        expect(settings.permissions.deny).toEqual(["Edit(*)"]);
    });

    test("maps write permission to Edit(*)", () => {
        const settings = permissionsToClaudeSettings({ write: "deny" });
        expect(settings.permissions.deny).toEqual(["Edit(*)"]);
    });

    test("maps find and ls to Bash(*)", () => {
        const settings = permissionsToClaudeSettings({ find: "allow", ls: "allow" });
        expect(settings.permissions.allow).toEqual(["Bash(*)", "Bash(*)"]);
    });

    test("maps bash, read, and grep to capitalized categories", () => {
        const settings = permissionsToClaudeSettings({
            bash: "allow",
            read: "ask",
            grep: "deny",
        });
        expect(settings.permissions.allow).toEqual(["Bash(*)"]);
        expect(settings.permissions.ask).toEqual(["Read(*)"]);
        expect(settings.permissions.deny).toEqual(["Grep(*)"]);
    });

    test("wildcard expands to all known categories", () => {
        const settings = permissionsToClaudeSettings({ "*": "deny" });
        expect(settings.permissions.deny).toEqual([
            "Edit(*)",
            "Bash(*)",
            "Read(*)",
            "Grep(*)",
            "Bash(*)",
            "Bash(*)",
            "Edit(*)",
        ]);
    });

    test("ignores invalid decisions", () => {
        // @ts-expect-error testing invalid input
        const settings = permissionsToClaudeSettings({ edit: "invalid" });
        expect(settings.permissions.deny).toEqual([]);
    });

    test("empty permissions yield empty settings", () => {
        const settings = permissionsToClaudeSettings({});
        expect(settings.permissions.allow).toEqual([]);
        expect(settings.permissions.ask).toEqual([]);
        expect(settings.permissions.deny).toEqual([]);
    });
});
