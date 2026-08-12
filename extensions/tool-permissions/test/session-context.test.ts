import { describe, expect, test } from "bun:test";

import { buildSessionContext, type ExecFn } from "../src/session-context";

/** Minimal session entry shape — only the fields buildSessionContext reads. */
type AnyEntry = { type: string; message?: { role: string; content?: unknown } };

/** Build an assistant message entry carrying toolCalls. */
function assistantEntry(toolCalls: { name: string; arguments: Record<string, unknown> }[]): AnyEntry {
    return {
        type: "message",
        message: {
            role: "assistant",
            content: toolCalls.map(tc => ({ type: "toolCall", name: tc.name, arguments: tc.arguments })),
        },
    };
}

function userEntry(text: string): AnyEntry {
    return { type: "message", message: { role: "user", content: text } };
}

function userEntryBlocks(texts: string[]): AnyEntry {
    return {
        type: "message",
        message: { role: "user", content: texts.map(t => ({ type: "text", text: t })) },
    };
}

function compactionEntry(): AnyEntry {
    return { type: "compaction" };
}

/** Build a stubbed exec that responds to specific argv shapes. */
function makeExec(stubs: { args: string[]; stdout?: string; code?: number }[]): ExecFn {
    const calls: { args: string[]; cwd?: string }[] = [];
    const fn: ExecFn = async (_cmd, args, opts) => {
        calls.push({ args, cwd: opts?.cwd });
        const stub = stubs.find(s => s.args.join(" ") === args.join(" "));
        if (!stub) return { stdout: "", stderr: "", code: 1, killed: false };
        return { stdout: stub.stdout ?? "", stderr: "", code: stub.code ?? 0, killed: false };
    };
    Object.defineProperty(fn, "calls", { value: calls, enumerable: false, writable: false });
    return fn;
}

/** Cast our duck-typed entries to SessionEntry for the call site. */
function asEntries(entries: AnyEntry[]): Parameters<typeof buildSessionContext>[0] {
    return entries as unknown as Parameters<typeof buildSessionContext>[0];
}

describe("buildSessionContext", () => {
    test("recentToolCalls derives from assistant toolCall blocks, oldest→newest, capped at 12", async () => {
        const entries = asEntries(
            Array.from({ length: 15 }, (_, i) =>
                assistantEntry([{ name: "bash", arguments: { command: `echo ${i}` } }]),
            ),
        );
        const ctx = await buildSessionContext(entries, "/repo", makeExec([]));
        expect(ctx.recentToolCalls?.length).toBe(12);
        // Oldest kept is the 4th call (`echo 3`) since the scan keeps the last 12.
        expect(ctx.recentToolCalls?.[0]).toBe("bash: echo 3");
        expect(ctx.recentToolCalls?.[11]).toBe("bash: echo 14");
    });

    test("agentTouchedFiles derives from read/edit/write toolCalls, deduped, capped at 30", async () => {
        const entries = asEntries([
            assistantEntry([{ name: "write", arguments: { file_path: "src/a.ts" } }]),
            assistantEntry([{ name: "edit", arguments: { file_path: "src/a.ts" } }]), // dup
            assistantEntry([{ name: "read", arguments: { path: "src/b.ts" } }]),
            assistantEntry([{ name: "bash", arguments: { command: "touch src/a.ts" } }]), // not touched
            assistantEntry([{ name: "ls", arguments: { path: "src" } }]), // not touched
        ]);
        const ctx = await buildSessionContext(entries, "/repo", makeExec([]));
        expect(ctx.agentTouchedFiles).toEqual(["src/a.ts", "src/b.ts"]); // oldest→newest
    });

    test("bash toolCall argument is truncated to the bounded length", async () => {
        const entries = asEntries([
            assistantEntry([{ name: "bash", arguments: { command: "x".repeat(400) } }]),
        ]);
        const ctx = await buildSessionContext(entries, "/repo", makeExec([]));
        // Entry is `bash: ` (6) + truncated-to-120 arg, capped at 126.
        expect(ctx.recentToolCalls?.[0]?.length).toBeLessThanOrEqual(126);
        expect(ctx.recentToolCalls?.[0]?.endsWith("…")).toBe(true);
    });

    test("lastUserPrompt uses the most recent user message (string content)", async () => {
        const entries = asEntries([
            userEntry("old prompt"),
            assistantEntry([{ name: "bash", arguments: { command: "echo a" } }]),
            userEntry("the latest prompt"),
        ]);
        const ctx = await buildSessionContext(entries, "/repo", makeExec([]));
        expect(ctx.lastUserPrompt).toBe("the latest prompt");
    });

    test("lastUserPrompt concatenates text content blocks", async () => {
        const entries = asEntries([
            userEntryBlocks(["line one", "line two"]),
        ]);
        const ctx = await buildSessionContext(entries, "/repo", makeExec([]));
        expect(ctx.lastUserPrompt).toBe("line one\nline two");
    });

    test("lastUserPrompt is truncated to the bounded length", async () => {
        const entries = asEntries([userEntry("x".repeat(500))]);
        const ctx = await buildSessionContext(entries, "/repo", makeExec([]));
        expect(ctx.lastUserPrompt?.length).toBeLessThanOrEqual(300);
        expect(ctx.lastUserPrompt?.endsWith("…")).toBe(true);
    });

    test("scan stops at the latest compaction entry (older history is summarized)", async () => {
        const entries = asEntries([
            assistantEntry([{ name: "write", arguments: { file_path: "old.ts" } }]),
            userEntry("ancient prompt"),
            compactionEntry(),
            assistantEntry([{ name: "write", arguments: { file_path: "new.ts" } }]),
            userEntry("fresh prompt"),
        ]);
        const ctx = await buildSessionContext(entries, "/repo", makeExec([]));
        expect(ctx.agentTouchedFiles).toEqual(["new.ts"]);
        expect(ctx.lastUserPrompt).toBe("fresh prompt");
        expect(ctx.recentToolCalls).toEqual(["write: new.ts"]);
    });

    test("gitRemote parses SSH and HTTPS remote URLs", async () => {
        const exec = makeExec([
            { args: ["remote", "get-url", "origin"], stdout: "git@github.com:org/repo.git\n", code: 0 },
            { args: ["status", "--porcelain=v1"], stdout: "", code: 0 },
        ]);
        const ctx = await buildSessionContext(asEntries([]), "/repo", exec);
        expect(ctx.gitRemote).toBe("github.com");
    });

    test("gitRemote falls back to first listed remote when origin is missing", async () => {
        const exec = makeExec([
            { args: ["remote", "get-url", "origin"], code: 1 },
            { args: ["remote"], stdout: "upstream\n", code: 0 },
            { args: ["remote", "get-url", "upstream"], stdout: "https://gitlab.com/org/repo.git\n", code: 0 },
            { args: ["status", "--porcelain=v1"], stdout: "", code: 0 },
        ]);
        const ctx = await buildSessionContext(asEntries([]), "/repo", exec);
        expect(ctx.gitRemote).toBe("gitlab.com");
    });

    test("git status preserves the porcelain leading space and is included", async () => {
        const exec = makeExec([
            { args: ["remote", "get-url", "origin"], code: 1 },
            { args: ["remote"], code: 1 },
            { args: ["status", "--porcelain=v1"], stdout: " M src/a.ts\n?? .env\n", code: 0 },
        ]);
        const ctx = await buildSessionContext(asEntries([]), "/repo", exec);
        // Leading space on ` M` is the porcelain status field — preserved.
        expect(ctx.gitStatus).toBe(" M src/a.ts\n?? .env");
    });

    test("git status is truncated to the line cap", async () => {
        const many = Array.from({ length: 100 }, (_, i) => ` M f${i}.ts`).join("\n");
        const exec = makeExec([
            { args: ["remote", "get-url", "origin"], code: 1 },
            { args: ["remote"], code: 1 },
            { args: ["status", "--porcelain=v1"], stdout: many, code: 0 },
        ]);
        const ctx = await buildSessionContext(asEntries([]), "/repo", exec);
        expect(ctx.gitStatus?.split("\n").length).toBe(40);
    });

    test("git fields are undefined when not a repo", async () => {
        const exec = makeExec([
            { args: ["remote", "get-url", "origin"], code: 1 },
            { args: ["remote"], code: 1 },
            { args: ["status", "--porcelain=v1"], code: 1 },
        ]);
        const ctx = await buildSessionContext(asEntries([]), "/repo", exec);
        expect(ctx.gitRemote).toBeUndefined();
        expect(ctx.gitStatus).toBeUndefined();
    });

    test("empty entries yield no recentToolCalls/agentTouchedFiles/lastUserPrompt", async () => {
        const exec = makeExec([
            { args: ["remote", "get-url", "origin"], code: 1 },
            { args: ["remote"], code: 1 },
            { args: ["status", "--porcelain=v1"], code: 1 },
        ]);
        const ctx = await buildSessionContext(asEntries([]), "/repo", exec);
        expect(ctx.recentToolCalls).toEqual([]);
        expect(ctx.agentTouchedFiles).toEqual([]);
        expect(ctx.lastUserPrompt).toBeUndefined();
        expect(ctx.cwd).toBe("/repo");
    });
});
