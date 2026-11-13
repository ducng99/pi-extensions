import { describe, expect, test } from "bun:test";

import { getOutOfBoundsPath, isOutOfBounds } from "./bounds";

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

describe("getOutOfBoundsPath", () => {
    const cwd = "/home/user/project";

    test("returns null for an in-bounds path", () => {
        expect(getOutOfBoundsPath("read", { path: "src/main.ts" }, cwd, [])).toBeNull();
    });

    test("returns the resolved out-of-bounds path", () => {
        expect(getOutOfBoundsPath("read", { path: "/etc/passwd" }, cwd, [])).toBe("/etc/passwd");
    });

    test("resolves a relative out-of-bounds path against cwd", () => {
        expect(getOutOfBoundsPath("read", { path: "../../etc/passwd" }, cwd, [])).toBe("/home/etc/passwd");
    });

    test("returns null for a path inside an additional directory", () => {
        expect(getOutOfBoundsPath("read", { path: "/home/user/shared/a.txt" }, cwd, ["/home/user/shared"])).toBeNull();
    });

    test("returns null for bash and unknown tools", () => {
        expect(getOutOfBoundsPath("bash", { command: "cat /etc/passwd" }, cwd, [])).toBeNull();
        expect(getOutOfBoundsPath("unknown-tool", { path: "/etc/passwd" }, cwd, [])).toBeNull();
    });
});
