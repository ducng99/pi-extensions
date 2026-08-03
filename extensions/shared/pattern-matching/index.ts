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

    // Domain pattern matching (for webfetch)
    if (pattern.startsWith("domain:")) {
        return matchDomain(pattern.slice(7), text);
    }

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

/**
 * Match a domain pattern against a domain string.
 * - "example.com" matches exactly "example.com" (no subdomains)
 * - "*.example.com" matches subdomains like "foo.example.com" but not "example.com"
 */
function matchDomain(pattern: string, url: string): boolean {
    try {
        const domain = new URL(url).hostname;
        // Wildcard subdomain pattern: *.example.com
        if (pattern.startsWith("*.")) {
            const baseDomain = pattern.slice(2); // remove "*."
            // Match subdomains only: domain must end with .baseDomain and not be baseDomain itself
            return domain !== baseDomain && domain.endsWith("." + baseDomain);
        }

        // Exact match only
        return domain === pattern;
    }
    catch {
        return false;
    }
}
