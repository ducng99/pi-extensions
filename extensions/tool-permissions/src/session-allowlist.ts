// ============================================================================
// Session Allowlist
// ============================================================================
//
// When the user approves a tool call with "Yes, allow this session", we
// remember the (toolName, argString) pair so subsequent matching calls skip
// the prompt. The set is keyed identically to permission rules
// (`toolName:argString`, where argString is whatever `buildArgString` returns
// for that tool), so a session-allow decision lines up with what an explicit
// `Allow("Edit(...):path")` rule would have matched.
//
// Scope: a single session (the lifetime of one `pi` process). It is reset
// when the extension's state is reset on `session_start`. The allowlist is
// deliberately in-memory only — it never persists to disk and never merges
// into claude settings — so a transient in-session decision does not survive
// a restart.

import { buildArgString } from "./permission-check";

export class SessionAllowlist {
    private readonly keys = new Set<string>();

    /**
     * Compose the allowlist key for a tool call. The same `buildArgString`
     * used by the permission rules is reused so session allows and explicit
     * allow rules see identical arguments.
     */
    private keyFor(toolName: string, input: Record<string, unknown>): string {
        return `${toolName}:${buildArgString(toolName, input)}`;
    }

    /** True when the (tool, input) pair was previously approved for the session. */
    allows(toolName: string, input: Record<string, unknown>): boolean {
        return this.keys.has(this.keyFor(toolName, input));
    }

    /** Remember the (tool, input) pair as approved for the rest of this session. */
    add(toolName: string, input: Record<string, unknown>): void {
        this.keys.add(this.keyFor(toolName, input));
    }

    /** Wipe the allowlist (currently unused; reserved for future commands). */
    clear(): void {
        this.keys.clear();
    }

    /** Number of entries currently allowed. Useful for tests and diagnostics. */
    get size(): number {
        return this.keys.size;
    }
}
