import { describe, expect, test } from "bun:test";

import { isOutOfBounds } from "./bounds";

describe("isOutOfBounds: bash commands", () => {
    const cwd = "/home/user/project";

    // Bash bounds checking is handled in checkBashPermission with cd-aware
    // effective cwd tracking. isOutOfBounds always returns false for bash.
    test("returns false for bash command — bounds checked by checkBashPermission", () => {
        const result = isOutOfBounds("bash", { command: "cat /etc/passwd" }, cwd, []);
        expect(result).toBe(false);
    });

    test("returns false for non-bash tool inside cwd", () => {
        const result = isOutOfBounds("read", { path: "src/main.ts" }, cwd, []);
        expect(result).toBe(false);
    });

    test("returns true for non-bash tool outside cwd", () => {
        const result = isOutOfBounds("read", { path: "/etc/passwd" }, cwd, []);
        expect(result).toBe(true);
    });

    test("returns false for unknown tool", () => {
        const result = isOutOfBounds("unknown-tool", { path: "/etc/passwd" }, cwd, []);
        expect(result).toBe(false);
    });
});
