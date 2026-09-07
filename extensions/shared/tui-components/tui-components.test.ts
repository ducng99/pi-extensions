import { initTheme } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, test } from "bun:test";

import { PermissionSelector } from "./index";

describe("PermissionSelector scrollable title", () => {
    beforeAll(() => {
        try {
            initTheme("default");
        }
        catch {
            // Theme already initialized.
        }
    });
    test("long command: panel height bounded, options visible at the end", () => {
        const done = () => {};
        const longCmd = "Command: " + Array.from({ length: 200 }, (_, i) => `echo line ${i} &&`).join(" ");
        const sel = new PermissionSelector(longCmd, "Allow bash?", done, { maxTitleLines: 6, terminalRows: 30 });
        const lines = sel.render(80);
        // bounded height: 6 window + 1 hint + 9 fixed + 2 options = 18 <= 30 - 2
        expect(lines.length).toBeLessThanOrEqual(28);
        // options and hints are present
        expect(lines.join("\n")).toContain("Allow bash?");
        expect(lines.join("\n")).toContain("→ Yes");
        expect(lines.join("\n")).toContain("No");
        // scroll hint shown
        expect(lines.join("\n")).toContain("scroll");
        // last line is the bottom border
        const esc = String.fromCharCode(27);
        const stripAnsi = new RegExp(`${esc}\\[[0-9;]*m`, "g");
        expect(lines[lines.length - 1]!.replace(stripAnsi, "")).toBe("─".repeat(80));
    });

    test("short command: no scroll hint, no extra chrome", () => {
        const done = () => {};
        const sel = new PermissionSelector("Command: ls -la", "Allow bash?", done, { maxTitleLines: 6, terminalRows: 30 });
        const lines = sel.render(80);
        expect(lines.join("\n")).not.toContain("scroll");
        expect(lines.join("\n")).toContain("→ Yes");
    });

    test("pageDown scrolls, home/end jump, wheel scrolls", () => {
        const done = () => {};
        const longCmd = "Command: " + Array.from({ length: 100 }, (_, i) => `echo line ${i} &&`).join(" ");
        const sel = new PermissionSelector(longCmd, "Allow bash?", done, { maxTitleLines: 4, terminalRows: 30 });
        sel.render(80);
        const first = sel.render(80).join("\n");
        expect(first).toContain("echo line 0");
        // PageDown
        sel.handleInput("\x1b[6~");
        const afterPg = sel.render(80).join("\n");
        expect(afterPg).not.toContain("echo line 0");
        // Home jumps back to the top
        sel.handleInput("\x1b[H");
        expect(sel.render(80).join("\n")).toContain("echo line 0");
        // End jumps to the bottom
        sel.handleInput("\x1b[F");
        expect(sel.render(80).join("\n")).not.toContain("echo line 0");
        // Wheel down scrolls further (SGR sequence: button 65 = wheel down)
        sel.handleInput("\x1b[H");
        sel.handleInput("\x1b[<65;10;20M");
        const afterWheel = sel.render(80).join("\n");
        expect(afterWheel).not.toContain("echo line 0");
        // Wheel up goes back
        sel.handleInput("\x1b[<64;10;20M");
        expect(sel.render(80).join("\n")).toContain("echo line 0");
    });
});

describe("PermissionSelector custom options", () => {
    beforeAll(() => {
        try {
            initTheme("default");
        }
        catch {
            // Theme already initialized.
        }
    });

    test("default Yes/No behaves identically to the legacy layout", () => {
        const calls: { allow: boolean; allowSession?: boolean; message?: string }[] = [];
        const sel = new PermissionSelector("Read file", "Allow read?", r => calls.push(r));
        expect(sel.render(80).join("\n")).toContain("→ Yes");
        expect(sel.render(80).join("\n")).toContain("No");
        // Enter on Yes → allow
        sel.handleInput("\n");
        expect(calls).toEqual([{ allow: true }]);
    });

    test("Enter on No (default) denies immediately, with no message", () => {
        const calls: { allow: boolean; allowSession?: boolean; message?: string }[] = [];
        const sel = new PermissionSelector("Read file", "Allow read?", r => calls.push(r));
        // Move selection down to No
        sel.handleInput("j");
        sel.handleInput("\n");
        expect(calls).toEqual([{ allow: false }]);
    });

    test("Tab on No opens input mode; Enter submits deny with message", () => {
        const calls: { allow: boolean; allowSession?: boolean; message?: string }[] = [];
        const sel = new PermissionSelector("Read file", "Allow read?", r => calls.push(r));
        sel.handleInput("j"); // focus No
        sel.handleInput("\t"); // enter input mode
        // Type a reason and submit (NoInputInline forwards input to its child Input,
        // so plain characters land in the field).
        for (const ch of "nope") sel.handleInput(ch);
        sel.handleInput("\n");
        expect(calls).toEqual([{ allow: false, message: "nope" }]);
    });

    test("Three-option layout: Yes / Yes, allow this session / No renders in order", () => {
        const sel = new PermissionSelector(
            "Edit file: src/main.ts",
            "Allow edit?",
            () => {},
            {
                options: [
                    { label: "Yes", kind: "allow" },
                    { label: "Yes, allow this session", kind: "allowSession" },
                    { label: "No", kind: "denyWithMessage" },
                ],
            },
        );
        const lines = sel.render(80);
        const rendered = lines.join("\n");
        expect(rendered).toContain("→ Yes");
        expect(rendered).toContain("Yes, allow this session");
        expect(rendered).toContain("No");
        // Verify the order matches the options array.
        const yesIdx = rendered.indexOf("→ Yes");
        const sessionIdx = rendered.indexOf("Yes, allow this session");
        const noIdx = rendered.lastIndexOf("No");
        expect(yesIdx).toBeLessThan(sessionIdx);
        expect(sessionIdx).toBeLessThan(noIdx);
    });

    test("Selecting 'Yes, allow this session' returns allowSession=true", () => {
        const calls: { allow: boolean; allowSession?: boolean; message?: string }[] = [];
        const sel = new PermissionSelector(
            "Edit file",
            "Allow edit?",
            r => calls.push(r),
            {
                options: [
                    { label: "Yes", kind: "allow" },
                    { label: "Yes, allow this session", kind: "allowSession" },
                    { label: "No", kind: "denyWithMessage" },
                ],
            },
        );
        sel.handleInput("j"); // focus option 1 (session)
        sel.handleInput("\n");
        expect(calls).toEqual([{ allow: true, allowSession: true }]);
    });

    test("Selecting 'Yes' (first) returns allowSession=undefined", () => {
        const calls: { allow: boolean; allowSession?: boolean; message?: string }[] = [];
        const sel = new PermissionSelector(
            "Edit file",
            "Allow edit?",
            r => calls.push(r),
            {
                options: [
                    { label: "Yes", kind: "allow" },
                    { label: "Yes, allow this session", kind: "allowSession" },
                    { label: "No", kind: "denyWithMessage" },
                ],
            },
        );
        sel.handleInput("\n");
        expect(calls).toEqual([{ allow: true }]);
        expect(calls[0]!.allowSession).toBeUndefined();
    });

    test("Selecting 'No' (third) returns allow=false", () => {
        const calls: { allow: boolean; allowSession?: boolean; message?: string }[] = [];
        const sel = new PermissionSelector(
            "Edit file",
            "Allow edit?",
            r => calls.push(r),
            {
                options: [
                    { label: "Yes", kind: "allow" },
                    { label: "Yes, allow this session", kind: "allowSession" },
                    { label: "No", kind: "denyWithMessage" },
                ],
            },
        );
        sel.handleInput("j");
        sel.handleInput("j"); // focus option 2 (No)
        sel.handleInput("\n");
        expect(calls).toEqual([{ allow: false }]);
    });

    test("Tab is only enabled for the denyWithMessage option (Yes → no tab hint)", () => {
        const sel = new PermissionSelector(
            "Edit file",
            "Allow edit?",
            () => {},
            {
                options: [
                    { label: "Yes", kind: "allow" },
                    { label: "Yes, allow this session", kind: "allowSession" },
                    { label: "No", kind: "denyWithMessage" },
                ],
            },
        );
        // Default selection (index 0 = "Yes") → no "deny with message" hint.
        expect(sel.render(80).join("\n")).not.toContain("deny with message");
        // Move to the session option → still no deny hint.
        sel.handleInput("j");
        expect(sel.render(80).join("\n")).not.toContain("deny with message");
        // Move to No → deny hint appears.
        sel.handleInput("j");
        expect(sel.render(80).join("\n")).toContain("deny with message");
    });

    test("Tab on a non-denyWithMessage option is a no-op (does not enter input mode)", () => {
        const calls: { allow: boolean; allowSession?: boolean; message?: string }[] = [];
        const sel = new PermissionSelector(
            "Edit file",
            "Allow edit?",
            r => calls.push(r),
            {
                options: [
                    { label: "Yes", kind: "allow" },
                    { label: "Yes, allow this session", kind: "allowSession" },
                    { label: "No", kind: "denyWithMessage" },
                ],
            },
        );
        // Focus the session option (index 1) and press Tab — should be ignored.
        sel.handleInput("j");
        sel.handleInput("\t");
        // Pressing Enter afterwards should still submit the session option,
        // proving we didn't enter input mode.
        sel.handleInput("\n");
        expect(calls).toEqual([{ allow: true, allowSession: true }]);
    });

    test("A custom 'deny' option (no Tab behavior) still denies on Enter", () => {
        const calls: { allow: boolean; allowSession?: boolean; message?: string }[] = [];
        const sel = new PermissionSelector(
            "Edit file",
            "Allow edit?",
            r => calls.push(r),
            {
                options: [
                    { label: "Yes", kind: "allow" },
                    { label: "No", kind: "deny" },
                ],
            },
        );
        sel.handleInput("j"); // focus No
        sel.handleInput("\t"); // Tab is ignored (no denyWithMessage option)
        sel.handleInput("\n");
        expect(calls).toEqual([{ allow: false }]);
    });

    test("Input mode 'No, <input>' prefix uses the option's label, not a hardcoded 'No'", () => {
        const sel = new PermissionSelector(
            "Edit file",
            "Allow edit?",
            () => {},
            {
                options: [
                    { label: "Yes", kind: "allow" },
                    { label: "Reject", kind: "denyWithMessage" },
                ],
            },
        );
        sel.handleInput("j"); // focus Reject
        sel.handleInput("\t"); // enter input mode
        // The inline prefix is "→ Reject, " rather than "→ No, ".
        const rendered = sel.render(80).join("\n");
        expect(rendered).toContain("Reject,");
        expect(rendered).not.toContain("No,");
    });
});
