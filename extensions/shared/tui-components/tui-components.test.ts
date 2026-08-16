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
        // bounded height: 6 window + 1 hint + 11 fixed = 18 <= 30 - 2
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
