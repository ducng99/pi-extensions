/**
 * Check if a token looks like a file path.
 */
function looksLikePath(token: string): boolean {
    // POSIX absolute and root-relative; Windows drive-relative (`\foo`).
    if (token.startsWith("/") || token.startsWith("\\")) return true;
    if (token.startsWith("~")) return true;
    // POSIX and Windows relative (`.\`, `..\`).
    if (token.startsWith("./") || token.startsWith(".\\")) return true;
    if (token.startsWith("../") || token.startsWith("..\\")) return true;
    if (token === "." || token === "..") return true;
    // Absolute Windows path with a drive letter, e.g. `C:\foo` or `C:/foo`.
    if (/^[a-zA-Z]:[\\/]/.test(token)) return true;
    if (token.includes("/") || token.includes("\\")) return true;
    return false;
}

/**
 * Strip matching outer quotes from a token.
 */
function stripQuotes(token: string): string {
    if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
        return token.slice(1, -1);
    }
    if (token.length >= 2 && token.startsWith("'") && token.endsWith("'")) {
        return token.slice(1, -1);
    }
    return token;
}

/**
 * Extract a path value from a token, handling `--key=/path` style arguments.
 */
function extractPathValue(token: string): string | null {
    const unquoted = stripQuotes(token);
    if (unquoted.startsWith("--") && unquoted.includes("=")) {
        const value = unquoted.slice(unquoted.indexOf("=") + 1);
        if (looksLikePath(value)) return value;
    }
    if (looksLikePath(unquoted)) return unquoted;
    return null;
}

/**
 * Commands whose first positional argument is a regex pattern (grep, rg), a
 * sed script, or an awk program rather than a file path. Patterns can
 * legitimately start with `/` (e.g. `grep '/etc/passwd' file`,
 * `awk '/etc/hosts/ {print}' file`), which would otherwise be mistaken for an
 * absolute path by the out-of-bounds check.
 */
const PATTERN_POSITION_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg", "sed", "awk", "gawk", "mawk", "nawk"]);

/**
 * awk and its common variants — all share the same option/argument layout
 * (first positional is the program, `-f`/`-e` supply it, `-F`/`-v` take
 * non-path values).
 */
const AWK_COMMANDS = new Set(["awk", "gawk", "mawk", "nawk"]);

/**
 * awk options whose value is neither a pattern nor a path: `-F FS` (field
 * separator) and `-v VAR=VALUE` (variable assignment). The value must be
 * skipped without consuming the pattern slot, so the program that follows is
 * still recognized as the program/pattern positional.
 */
const AWK_VALUE_OPTIONS = new Set(["F", "v"]);

/**
 * Long forms of awk's value options (`--field-separator=`, `--assignments=`),
 * accepted with `=` or as a separate value.
 */
const AWK_VALUE_LONG_OPTIONS = new Set(["--field-separator", "--assignments"]);

/**
 * Long options that take a regex pattern/script as their value, per command.
 * Both `--opt value` and `--opt=value` forms are accepted.
 */
const PATTERN_LONG_OPTIONS: Record<string, Set<string>> = {
    grep: new Set(["--regexp"]),
    egrep: new Set(["--regexp"]),
    fgrep: new Set(["--regexp"]),
    rg: new Set(["--regexp"]),
    sed: new Set(["--expression"]),
};

/**
 * Long option that takes a *pattern file* as its value (e.g. `grep -f FILE`).
 * The value is a real file path and is still bounds-checked, but its presence
 * fills the positional pattern slot (so subsequent positionals are all files).
 */
const PATTERN_FILE_LONG_OPTIONS = new Set(["--file"]);

/**
 * Options that switch a pattern-based command into a mode with no pattern at
 * all (e.g. `rg --files`), so every positional argument is a path.
 */
const NO_PATTERN_OPTIONS: Record<string, Set<string>> = {
    rg: new Set(["--files", "--type-list"]),
};

/**
 * Classification of a single argument token of a pattern-based command.
 */
type PatternOptionKind
    = | { kind: "pattern"; value: string; separate: boolean }
        | { kind: "pattern-file"; value: string; separate: boolean }
        | { kind: "value-option"; separate: boolean }
        | { kind: "plain-option" }
        | { kind: "not-option" };

/**
 * Classify a single argument token of a pattern-based command (grep/rg/sed/awk).
 *
 * `separate: true` means the value is the *next* argument (e.g. `-e PATTERN`),
 * `separate: false` means the value is attached to this token (e.g.
 * `-ePATTERN`, `--regexp=PATTERN`). Short-option bundles are scanned so that
 * `-rePATTERN` is recognized as `-r -e PATTERN`.
 */
function classifyPatternOption(command: string, token: string): PatternOptionKind {
    if (token === "-" || token === "--") return { kind: "not-option" };

    // Long options: `--regexp[=...]`, `--expression[=...]`, `--file[=...]`.
    if (token.startsWith("--")) {
        const eq = token.indexOf("=");
        const name = eq === -1 ? token : token.slice(0, eq);
        const value = eq === -1 ? "" : token.slice(eq + 1);

        if (PATTERN_LONG_OPTIONS[command]?.has(name)) {
            return { kind: "pattern", value, separate: eq === -1 };
        }
        if (PATTERN_FILE_LONG_OPTIONS.has(name)) {
            return { kind: "pattern-file", value, separate: eq === -1 };
        }
        if (AWK_COMMANDS.has(command) && AWK_VALUE_LONG_OPTIONS.has(name)) {
            return { kind: "value-option", separate: eq === -1 };
        }
        return { kind: "plain-option" };
    }

    // Short options and bundles (e.g. `-e`, `-ePAT`, `-re`, `-rePAT`, `-fFILE`).
    if (token.startsWith("-") && token.length > 1) {
        for (let j = 1; j < token.length; j++) {
            const c = token[j]!;
            // awk `-F:`/`-F :`, `-vx=1`/`-v x=1`: the value is a field
            // separator or an assignment, never a path.
            if (AWK_COMMANDS.has(command) && AWK_VALUE_OPTIONS.has(c)) {
                const attached = token.slice(j + 1);
                return { kind: "value-option", separate: attached === "" };
            }
            if (c === "e") {
                const attached = token.slice(j + 1);
                return { kind: "pattern", value: attached, separate: attached === "" };
            }
            if (c === "f") {
                const attached = token.slice(j + 1);
                return { kind: "pattern-file", value: attached, separate: attached === "" };
            }
            // `sed -i[SUFFIX]`: the rest of the token is an attached backup
            // suffix (e.g. `-i.bak`), not more options.
            if (command === "sed" && c === "i") {
                return { kind: "plain-option" };
            }
            // Other option characters take no value; keep scanning for a
            // bundled `-e`/`-f` (e.g. `-re`, `-rn`).
        }
        return { kind: "plain-option" };
    }

    return { kind: "not-option" };
}

/**
 * Extract file-path arguments from a single command's args, skipping regex
 * patterns, sed scripts, and awk programs for pattern-based commands
 * (grep/rg/sed/awk) so that a pattern such as `/etc/passwd` is not mistaken
 * for an absolute path.
 */
export function extractPathArgs(args: string[]): string[] {
    if (args.length === 0) return [];

    const command = args[0]!;

    // In modes like `rg --files`, there is no pattern at all — every
    // positional argument is a path.
    const noPatternMode = NO_PATTERN_OPTIONS[command] !== undefined
        && args.slice(1).some(a => NO_PATTERN_OPTIONS[command]!.has(a));
    const patternFirst = !noPatternMode && PATTERN_POSITION_COMMANDS.has(command);

    const paths: string[] = [];
    // True once a pattern/script has been supplied (via `-e`/`--regexp`/
    // `--expression`/`-f`/`--file`, or via the positional slot itself). Once
    // true, every remaining positional argument is a real file path.
    let patternSupplied = false;
    let optionsEnded = false;

    for (let i = 1; i < args.length; i++) {
        const token = args[i]!;

        if (patternFirst) {
            if (token === "--") {
                optionsEnded = true;
                continue;
            }

            if (!optionsEnded) {
                const opt = classifyPatternOption(command, token);

                if (opt.kind === "plain-option") {
                    continue;
                }

                if (opt.kind === "pattern") {
                    patternSupplied = true;
                    if (opt.separate) {
                        i++; // skip the separate pattern value
                    }
                    continue;
                }

                if (opt.kind === "pattern-file") {
                    patternSupplied = true;
                    const value = opt.separate ? args[i + 1] : opt.value;
                    if (opt.separate && value !== undefined) {
                        i++; // consume the separate file value
                    }
                    if (value !== undefined) {
                        const path = extractPathValue(value);
                        if (path) paths.push(path);
                    }
                    continue;
                }

                if (opt.kind === "value-option") {
                    // Non-path value (awk `-F`/`-v`): skip the separate value
                    // token without filling the pattern slot, so the program
                    // positional is still consumed as the pattern.
                    if (opt.separate && args[i + 1] !== undefined) {
                        i++;
                    }
                    continue;
                }

                // `not-option` → falls through to positional handling below.
            }
        }

        if (patternFirst && !patternSupplied) {
            // First positional of grep/rg/sed is the pattern/script, which may
            // look like an absolute path (`grep '/etc/passwd' file`).
            patternSupplied = true;
            continue;
        }

        const path = extractPathValue(token);
        if (path) {
            paths.push(path);
        }
    }

    return paths;
}

/**
 * Extract file paths from redirections in a raw command string.
 */
export function extractRedirectionPaths(command: string): string[] {
    const paths: string[] = [];
    const redirectRegex = /(?:^|[^<])(\d*>>?|&>>?)\s*([^\s&|;<>]+)/g;
    let match: RegExpExecArray | null;

    while ((match = redirectRegex.exec(command)) !== null) {
        const operator = match[1]!;
        const filePath = match[2]!;

        // Skip heredoc (<<) and here string (<<<)
        if (operator.startsWith("<<")) continue;
        // Skip /dev/null (POSIX) and NUL (Windows) null devices
        if (filePath === "/dev/null") continue;
        if (/^nul:?$/i.test(filePath)) continue;
        // Skip file descriptors (e.g., 2>&1)
        if (/^&\d+$/.test(filePath)) continue;
        // Skip numeric-only targets (could be fd references)
        if (/^\d+$/.test(filePath)) continue;

        paths.push(filePath);
    }

    return paths;
}
