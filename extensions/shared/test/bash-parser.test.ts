import { beforeAll, describe, expect, test } from "bun:test";

import { initParser, parseBashCommand } from "../bash-parser/index.js";

/**
 * Helper: extract just the arg strings from parsed results.
 */
function argStrings(cmd: string): string[] {
    const result = parseBashCommand(cmd);
    if (result.kind === "error") return ["__ERROR__"];
    if (result.kind === "complex") return ["__COMPLEX__"];
    return result.commands.map(c => c.argString);
}

// Initialize parser before all tests
beforeAll(async () => {
    await initParser();
});

// ============================================================================
// Simple commands
// ============================================================================

describe("simple commands", () => {
    test("single command", () => {
        expect(argStrings("ls")).toEqual(["ls"]);
    });

    test("command with args", () => {
        expect(argStrings("cat .env")).toEqual(["cat .env"]);
    });

    test("command with flags", () => {
        expect(argStrings("ls -la /tmp")).toEqual(["ls -la /tmp"]);
    });

    test("trims extra whitespace", () => {
        expect(argStrings("  cat   .env  ")).toEqual(["cat .env"]);
    });

    test("empty command", () => {
        expect(argStrings("")).toEqual([]);
    });

    test("quoted args stay together", () => {
        expect(argStrings("echo \"hello world\"")).toEqual(["echo \"hello world\""]);
    });

    test("single quoted args stay together", () => {
        expect(argStrings("echo 'hello world'")).toEqual(["echo 'hello world'"]);
    });
});

// ============================================================================
// Command separators: ; && || | &
// ============================================================================

describe("command separators", () => {
    test("semicolon separates commands", () => {
        const result = argStrings("sleep 1; cat .env");
        expect(result).toContain("sleep 1");
        expect(result).toContain("cat .env");
    });

    test("pipe separates commands", () => {
        const result = argStrings("cat .env | echo");
        expect(result).toContain("cat .env");
        expect(result).toContain("echo");
    });

    test("&& separates commands", () => {
        const result = argStrings("make build && make install");
        expect(result).toContain("make build");
        expect(result).toContain("make install");
    });

    test("|| separates commands", () => {
        const result = argStrings("curl http://example.com || echo failed");
        expect(result).toContain("curl http://example.com");
        expect(result).toContain("echo failed");
    });

    test("background & separates commands", () => {
        const result = argStrings("sleep 1 & echo done");
        expect(result).toContain("sleep 1");
        expect(result).toContain("echo done");
    });

    test("newline separates commands", () => {
        const result = argStrings("ls\ncat .env");
        expect(result).toContain("ls");
        expect(result).toContain("cat .env");
    });

    test("complex chain: sleep 1; cat .env | echo", () => {
        const result = argStrings("sleep 1; cat .env | echo");
        expect(result).toContain("sleep 1");
        expect(result).toContain("cat .env");
        expect(result).toContain("echo");
    });

    test("trailing redirection does not prevent && split", () => {
        const result = parseBashCommand("cd /a && bun build --outdir=/tmp/build 2>&1");
        expect(result.kind).toBe("commands");
        expect(result.commands).toEqual([
            { argString: "cd /a", args: ["cd", "/a"] },
            { argString: "bun build --outdir=/tmp/build 2>&1", args: ["bun", "build", "--outdir=/tmp/build"] },
        ]);
    });
});

// ============================================================================
// Command substitutions: $(...) and backticks → "complex"
// ============================================================================

describe("command substitutions", () => {
    test("$(...) is complex", () => {
        const result = parseBashCommand("echo $(cat .env)");
        expect(result.kind).toBe("complex");
        expect(result.commands).toEqual([{ argString: "echo $(cat .env)", args: ["echo"] }]);
    });

    test("backtick is complex", () => {
        const result = parseBashCommand("echo `cat .env`");
        expect(result.kind).toBe("complex");
    });

    test("nested command substitution is complex", () => {
        const result = parseBashCommand("echo $(echo $(cat .env))");
        expect(result.kind).toBe("complex");
    });
});

// ============================================================================
// Subshells: (...) → "complex" (we do not recurse into them)
// ============================================================================

describe("subshells", () => {
    test("(cmd) | grep is a complex top-level command", () => {
        const result = parseBashCommand("(cat .env) | grep key");
        expect(result.kind).toBe("complex");
        expect(result.commands).toEqual([
            { argString: "(cat .env)", args: [] },
            { argString: "grep key", args: ["grep", "key"] },
        ]);
    });

    test("subshell with multiple commands is complex", () => {
        const result = parseBashCommand("(ls; cat .env) | wc");
        expect(result.kind).toBe("complex");
    });
});

// ============================================================================
// find -exec / xargs
// ============================================================================

describe("find -exec and xargs", () => {
    test("find -exec is a complex top-level command", () => {
        const result = parseBashCommand("find . -name '*.ts' -exec cat {} \\;");
        expect(result.kind).toBe("complex");
        expect(result.commands).toEqual([
            { argString: "find . -name '*.ts' -exec cat {} \\;", args: ["find", ".", "-name", "'*.ts'", "-exec", "cat", "{}", "\\;"] },
        ]);
    });

    test("find -exec with multiple args is complex", () => {
        const result = parseBashCommand("find . -exec rm -rf {} \\;");
        expect(result.kind).toBe("complex");
    });

    test("xargs extracts the piped command", () => {
        const result = argStrings("cat .env | xargs rm");
        expect(result).toContain("cat .env");
        expect(result).toContain("xargs rm");
    });
});

// ============================================================================
// Redirections (kept as part of the top-level command)
// ============================================================================

describe("redirections", () => {
    test("output redirection is kept", () => {
        const result = parseBashCommand("cat .env > output.txt");
        expect(result.kind).toBe("commands");
        expect(result.commands).toEqual([{ argString: "cat .env > output.txt", args: ["cat", ".env"] }]);
    });

    test("input redirection is kept", () => {
        const result = parseBashCommand("cat < input.txt");
        expect(result.kind).toBe("commands");
        expect(result.commands).toEqual([{ argString: "cat < input.txt", args: ["cat"] }]);
    });

    test("stderr redirection is kept", () => {
        const result = parseBashCommand("cat .env 2>/dev/null");
        expect(result.kind).toBe("commands");
        expect(result.commands).toEqual([{ argString: "cat .env 2>/dev/null", args: ["cat", ".env"] }]);
    });

    test("append redirection is kept", () => {
        const result = parseBashCommand("cat .env >> output.txt");
        expect(result.kind).toBe("commands");
        expect(result.commands).toEqual([{ argString: "cat .env >> output.txt", args: ["cat", ".env"] }]);
    });
});

// ============================================================================
// Quoting edge cases
// ============================================================================

describe("quoting", () => {
    test("semicolons inside double quotes are not separators", () => {
        const result = argStrings("echo \"hello; world\"");
        expect(result).toEqual(["echo \"hello; world\""]);
    });

    test("pipes inside single quotes are not separators", () => {
        const result = argStrings("echo 'hello | world'");
        expect(result).toEqual(["echo 'hello | world'"]);
    });

    test("escaped semicolon is not a separator", () => {
        const result = argStrings("echo hello\\; world");
        expect(result).toEqual(["echo hello\\; world"]);
    });
});

// ============================================================================
// Complex cases → "complex" (deny rules only)
// ============================================================================

describe("complex cases fall back to ask", () => {
    test("process substitution <()", () => {
        const result = parseBashCommand("diff <(cat .env) <(cat .env.bak)");
        expect(result.kind).toBe("complex");
    });

    test("process substitution >()", () => {
        const result = parseBashCommand("cat > >(tee log.txt)");
        expect(result.kind).toBe("complex");
    });

    test("heredoc", () => {
        const result = parseBashCommand("cat <<EOF\nhello\nEOF");
        expect(result.kind).toBe("complex");
    });
});

// ============================================================================
// Error cases → "error" (ask user)
// ============================================================================

describe("error cases fall back to ask", () => {
    test("unterminated quote is error", () => {
        const result = parseBashCommand("echo \"unterminated");
        expect(result.kind).toBe("error");
    });
});
