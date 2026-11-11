import type { LeafCommand } from "../../../shared/bash-parser/index";

/**
 * Result of stripping an executing wrapper keyword (`time`, `nohup`,
 * `timeout`) from a leaf command.
 */
type WrapperStripResult
    = | { kind: "unmodified" }
        | { kind: "drop" }
        | { kind: "stripped"; args: string[]; argString: string };

/**
 * Return the remainder of a whitespace-normalized arg string after skipping
 * its first `count` argument tokens. `argTokens` must be the leading token
 * texts of `argString`. Returns null when a token cannot be located exactly
 * (e.g. quoted text whose inner whitespace was normalized away) — the caller
 * then keeps the command unmodified, which is the safe fallback: the wrapper
 * stays part of the matched string so no rule silently matches.
 */
function argStringAfterTokens(argString: string, argTokens: string[], count: number): string | null {
    let pos = 0;
    for (let i = 0; i < count; i++) {
        const token = argTokens[i];
        if (token === undefined) return null;
        while (pos < argString.length && /\s/.test(argString[pos]!)) pos++;
        if (!argString.startsWith(token, pos)) return null;
        pos += token.length;
    }
    while (pos < argString.length && /\s/.test(argString[pos]!)) pos++;
    return argString.slice(pos);
}

/**
 * Number of leading tokens of a GNU `timeout` header (keyword, options,
 * duration) — everything before the wrapped command. Returns null when the
 * header is not confidently recognizable: GNU treats everything after the
 * duration as the command, so an unrecognized header must not be stripped.
 */
function timeoutHeaderLength(args: string[]): number | null {
    let i = 1;
    while (i < args.length) {
        const arg = args[i]!;
        if (arg === "--") break;
        if (arg === "--preserve-status" || arg === "--foreground" || arg === "--verbose" || arg === "-v") {
            i++;
            continue;
        }
        if (arg === "-k" || arg === "--kill-after" || arg === "-s" || arg === "--signal") {
            i += 2; // option plus its separate value
            continue;
        }
        if (arg.startsWith("--kill-after=") || arg.startsWith("--signal=")) {
            i++;
            continue;
        }
        // Any other option-looking token is not recognized → don't strip.
        if (arg.startsWith("-") && arg.length > 1) return null;
        break;
    }
    // DURATION: a floating point number with an optional unit (s/m/h/d).
    const duration = args[i];
    if (duration === undefined || !/^\d+(?:\.\d+)?[smhd]?$/.test(duration)) return null;
    i++;
    // A wrapped command must follow (option-looking tokens after the duration
    // belong to the wrapped command, per GNU).
    return i < args.length ? i : null;
}

/**
 * Strip a single executing wrapper keyword from a leaf command.
 *
 * `time`, `nohup`, and `timeout` run the command that follows them, so the
 * wrapped command is what permission rules should match — the leaf is
 * evaluated without the wrapper. Bare wrappers that execute nothing (bare
 * `time`, `timeout --help`) are dropped entirely. Wrappers we cannot parse
 * confidently (unknown `timeout` options, variable durations, ...) are left
 * unmodified so they resolve through the normal deny/ask/allow flow.
 */
function stripWrapperCommand(c: LeafCommand): WrapperStripResult {
    const head = c.args[0];

    if (head === "time") {
        // Bare `time` only reports shell times — drop it.
        if (c.args.length === 1) return { kind: "drop" };
        const argString = argStringAfterTokens(c.argString, c.args, 1);
        if (argString === null) return { kind: "unmodified" };
        return { kind: "stripped", args: c.args.slice(1), argString };
    }

    if (head === "nohup") {
        // Bare `nohup` (or with only its --help/--version flags) runs no
        // command — drop it.
        if (c.args.length === 1 || c.args[1] === "--help" || c.args[1] === "--version") return { kind: "drop" };
        const argString = argStringAfterTokens(c.argString, c.args, 1);
        if (argString === null) return { kind: "unmodified" };
        return { kind: "stripped", args: c.args.slice(1), argString };
    }

    if (head === "timeout") {
        // `timeout --help`/`--version` alone runs no command — drop it.
        if (c.args.length === 2 && (c.args[1] === "--help" || c.args[1] === "--version")) return { kind: "drop" };
        const headerLength = timeoutHeaderLength(c.args);
        if (headerLength === null) return { kind: "unmodified" };
        const argString = argStringAfterTokens(c.argString, c.args, headerLength);
        if (argString === null) return { kind: "unmodified" };
        return { kind: "stripped", args: c.args.slice(headerLength), argString };
    }

    return { kind: "unmodified" };
}

/**
 * Strip all executing wrapper keywords (`time`, `nohup`, `timeout`) from a
 * leaf command, e.g. `nohup timeout 300 jq .` → `jq .`.
 */
export function stripWrapperCommands(c: LeafCommand): LeafCommand[] {
    const result = stripWrapperCommand(c);
    if (result.kind === "drop") return [];
    if (result.kind === "unmodified") return [c];
    return stripWrapperCommands({ ...c, args: result.args, argString: result.argString });
}
