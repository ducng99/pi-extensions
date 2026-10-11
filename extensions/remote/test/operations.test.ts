import { describe, expect, test } from "bun:test";

import { parseGrepRow, parseRgJsonRow, toRemotePath } from "../operations";
import { parseRemoteArgs } from "../state";

describe("toRemotePath", () => {
    const localCwd = "/home/me/project";
    const remoteCwd = "/srv/app";

    test("maps the cwd itself", () => {
        expect(toRemotePath("/home/me/project", localCwd, remoteCwd)).toBe("/srv/app");
    });

    test("maps subpaths", () => {
        expect(toRemotePath("/home/me/project/src/index.ts", localCwd, remoteCwd)).toBe("/srv/app/src/index.ts");
    });

    test("normalizes relative paths against the local cwd first", () => {
        expect(toRemotePath("src/index.ts", localCwd, remoteCwd)).toBe("/srv/app/src/index.ts");
        expect(toRemotePath("../other/file", localCwd, remoteCwd)).toBe("/home/me/other/file");
    });

    test("passes through paths outside the local cwd", () => {
        expect(toRemotePath("/etc/passwd", localCwd, remoteCwd)).toBe("/etc/passwd");
    });

    test("does not match other prefixes sharing a leading substring", () => {
        expect(toRemotePath("/home/me/project-other/file", localCwd, remoteCwd)).toBe("/home/me/project-other/file");
    });
});

describe("parseRgJsonRow", () => {
    test("parses match events", () => {
        const line = JSON.stringify({
            type: "match",
            data: {
                path: { text: "/srv/app/src/index.ts" },
                line_number: 12,
                lines: { text: "export function main() {}\n" },
            },
        });
        expect(parseRgJsonRow(line)).toEqual({
            filePath: "/srv/app/src/index.ts",
            lineNumber: 12,
            lineText: "export function main() {}\n",
        });
    });

    test("ignores non-match events and malformed lines", () => {
        expect(parseRgJsonRow(JSON.stringify({ type: "begin", data: {} }))).toBeNull();
        expect(parseRgJsonRow("not json")).toBeNull();
        expect(parseRgJsonRow(JSON.stringify({ type: "match", data: {} }))).toBeNull();
    });
});

describe("parseGrepRow", () => {
    test("parses match rows", () => {
        expect(parseGrepRow("./src/index.ts:12:export const x = 1;")).toEqual({
            filePath: "./src/index.ts",
            lineNumber: 12,
            lineText: "export const x = 1;",
        });
    });

    test("skips context rows and group separators", () => {
        expect(parseGrepRow("./src/index.ts-11-import a;")).toBeNull();
        expect(parseGrepRow("--")).toBeNull();
    });

    test("handles filenames containing colons and dashes", () => {
        expect(parseGrepRow("./a:b.txt:3:hi")).toEqual({
            filePath: "./a:b.txt",
            lineNumber: 3,
            lineText: "hi",
        });
        expect(parseGrepRow("./my-file.txt:3:hi")).toEqual({
            filePath: "./my-file.txt",
            lineNumber: 3,
            lineText: "hi",
        });
    });

    test("ignores non-matching lines", () => {
        expect(parseGrepRow("binary file matches")).toBeNull();
        expect(parseGrepRow("")).toBeNull();
    });
});

describe("parseRemoteArgs", () => {
    test("empty args mean status", () => {
        expect(parseRemoteArgs("")).toEqual({ action: "status" });
        expect(parseRemoteArgs("   ")).toEqual({ action: "status" });
    });

    test("parses connect with target and path", () => {
        expect(parseRemoteArgs("connect root@example.com /srv/app")).toEqual({
            action: "connect",
            target: "root@example.com",
            path: "/srv/app",
        });
    });

    test("parses connect with target only", () => {
        expect(parseRemoteArgs("connect myserver")).toEqual({
            action: "connect",
            target: "myserver",
            path: undefined,
        });
    });

    test("rejects connect without a target", () => {
        const parsed = parseRemoteArgs("connect");
        expect(parsed.action).toBe("unknown");
    });

    test("rejects connect with too many arguments", () => {
        expect(parseRemoteArgs("connect a b c").action).toBe("unknown");
    });

    test("parses stop and status", () => {
        expect(parseRemoteArgs("stop")).toEqual({ action: "stop" });
        expect(parseRemoteArgs("status")).toEqual({ action: "status" });
    });

    test("rejects unknown subcommands", () => {
        const parsed = parseRemoteArgs("frobnicate");
        expect(parsed.action).toBe("unknown");
    });
});
