// ============================================================================
// Pattern Matching
// ============================================================================

/**
 * Match a glob pattern (with * wildcards) against a text string.
 * "ls *" matches both "ls" and "ls -la".
 * "*" matches anything.
 */
export function matchPattern(pattern: string, text: string): boolean {
    if (pattern === "*") return true;

    // Special handling for " *" pattern - treat as "optional space followed by anything"
    // This allows "bun test *" to match both "bun test" and "bun test --coverage"
    const PLACEHOLDER = "\x00";
    const processed = pattern.replace(/ \*/g, PLACEHOLDER);

    // Convert glob pattern to regex: * → .*, escape other regex metacharacters
    let regexStr = "";
    for (let i = 0; i < processed.length; i++) {
        const ch = processed[i]!;
        if (ch === PLACEHOLDER) {
            regexStr += "( .*)?";
        }
        else if (ch === "*") {
            regexStr += ".*";
        }
        else if (".+?^${}()|[\\]".includes(ch)) {
            regexStr += "\\" + ch;
        }
        else {
            regexStr += ch;
        }
    }

    return new RegExp("^" + regexStr + "$").test(text);
}
