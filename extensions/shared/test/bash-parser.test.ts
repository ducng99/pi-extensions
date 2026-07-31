import { describe, expect, test, beforeAll } from "bun:test";
import { parseBashCommand, initParser, type ParsedCommand } from "../bash-parser/index.js";

/**
 * Helper: extract just the arg strings from parsed results.
 */
function argStrings(cmd: string): string[] {
  const result = parseBashCommand(cmd);
  if (result.kind === "complex") return ["__COMPLEX__"];
  return result.commands.map((c) => c.argString);
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
    expect(argStrings('echo "hello world"')).toEqual(['echo "hello world"']);
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
});

// ============================================================================
// Command substitutions: $(...) and backticks → "complex"
// ============================================================================

describe("command substitutions", () => {
  test("$(...) is complex", () => {
    const result = parseBashCommand("echo $(cat .env)");
    expect(result.kind).toBe("complex");
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
// Subshells: (...)
// ============================================================================

describe("subshells", () => {
  test("(cmd) extracts inner command", () => {
    const result = argStrings("(cat .env) | grep key");
    expect(result).toContain("cat .env");
    expect(result).toContain("grep key");
  });

  test("subshell with multiple commands", () => {
    const result = argStrings("(ls; cat .env) | wc");
    expect(result).toContain("ls");
    expect(result).toContain("cat .env");
    expect(result).toContain("wc");
  });
});

// ============================================================================
// find -exec / xargs
// ============================================================================

describe("find -exec and xargs", () => {
  test("find -exec extracts the exec command", () => {
    const result = argStrings("find . -name '*.ts' -exec cat {} \\;");
    expect(result).toContain("cat {}");
  });

  test("find -exec with multiple args", () => {
    const result = argStrings("find . -exec rm -rf {} \\;");
    expect(result).toContain("rm -rf {}");
  });

  test("xargs extracts the piped command", () => {
    // xargs gets its command from stdin, but we can check the xargs line itself
    const result = argStrings("cat .env | xargs rm");
    expect(result).toContain("cat .env");
    expect(result).toContain("xargs rm");
  });
});

// ============================================================================
// Redirections (should not affect command extraction)
// ============================================================================

describe("redirections", () => {
  test("output redirection", () => {
    const result = argStrings("cat .env > output.txt");
    expect(result).toContain("cat .env");
  });

  test("input redirection", () => {
    const result = argStrings("cat < input.txt");
    expect(result).toContain("cat");
  });

  test("stderr redirection", () => {
    const result = argStrings("cat .env 2>/dev/null");
    expect(result).toContain("cat .env");
  });

  test("append redirection", () => {
    const result = argStrings("cat .env >> output.txt");
    expect(result).toContain("cat .env");
  });
});

// ============================================================================
// Quoting edge cases
// ============================================================================

describe("quoting", () => {
  test("semicolons inside double quotes are not separators", () => {
    const result = argStrings('echo "hello; world"');
    expect(result).toEqual(['echo "hello; world"']);
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
// Complex cases → should return "complex"
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

  test("unterminated quote is complex", () => {
    // Tree-sitter creates ERROR node for unterminated quotes
    const result = parseBashCommand('echo "unterminated');
    expect(result.kind).toBe("complex");
  });
});
