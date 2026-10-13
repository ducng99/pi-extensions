import { describe, expect, test } from "bun:test";

import { baseArgs, parseTarget, shQuote, supportsControlMaster } from "../ssh";

describe("baseArgs", () => {
    test("includes common options and port", () => {
        const args = baseArgs({ target: "host", port: 2222 });
        expect(args).toContain("BatchMode=yes");
        expect(args).toContain("-p");
        expect(args).toContain("2222");
    });

    test("omits port when not specified", () => {
        expect(baseArgs({ target: "host" })).not.toContain("-p");
    });

    test(`ControlMaster options are ${supportsControlMaster() ? "included" : "omitted"} on this platform`, () => {
        const args = baseArgs({ target: "host" });
        const hasControl = args.some(a => a.startsWith("Control"));
        expect(hasControl).toBe(supportsControlMaster());
    });
});

describe("parseTarget", () => {
    test("parses user@host", () => {
        expect(parseTarget("root@example.com")).toEqual({ target: "root@example.com" });
    });

    test("parses ssh-config aliases verbatim", () => {
        expect(parseTarget("myserver")).toEqual({ target: "myserver" });
    });

    test("parses host:port", () => {
        expect(parseTarget("example.com:2222")).toEqual({ target: "example.com", port: 2222 });
    });

    test("parses user@host:port", () => {
        expect(parseTarget("root@example.com:2200")).toEqual({ target: "root@example.com", port: 2200 });
    });

    test("parses bracketed IPv6 with port", () => {
        expect(parseTarget("[::1]:22")).toEqual({ target: "::1", port: 22 });
    });

    test("keeps bare IPv6 verbatim", () => {
        expect(parseTarget("::1")).toEqual({ target: "::1" });
    });
});

describe("shQuote", () => {
    test("wraps plain strings", () => {
        expect(shQuote("hello")).toBe("'hello'");
    });

    test("escapes single quotes", () => {
        expect(shQuote("it's")).toBe("'it'\\''s'");
    });

    test("neutralizes shell metacharacters", () => {
        expect(shQuote("a; rm -rf /")).toBe("'a; rm -rf /'");
        expect(shQuote("$(whoami)")).toBe("'$(whoami)'");
        expect(shQuote("`id`")).toBe("'`id`'");
    });

    test("handles empty strings", () => {
        expect(shQuote("")).toBe("''");
    });
});
