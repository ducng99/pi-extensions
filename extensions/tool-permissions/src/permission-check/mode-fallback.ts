import type { PermissionDecision, PermissionMode } from "./types";
import { REASON_AUTO_MODE_DENIED } from "./types";

/**
 * Resolve an unresolved tool call according to the active mode:
 * - `"auto"` — consult the classifier; a deny verdict blocks the call with a
 *   fixed, user-facing reason while the classifier's own reason (with its
 *   score) is surfaced as a notification instead of the block message.
 * - `"allow"` — default to allow (out-of-bounds and sensitive-path asks have
 *   already been enforced by the caller before reaching this point).
 * - `"off"` — ask the user.
 *
 * `classify` is a thunk so that in allow/off mode the classifier (and any
 * lazily-built session context) is never invoked.
 */
export async function resolveModeFallback(
    toolName: string,
    input: Record<string, unknown>,
    mode: PermissionMode,
    signal: AbortSignal | undefined,
    classify: () => Promise<PermissionDecision>,
): Promise<PermissionDecision> {
    if (mode === "allow") return { decision: "allow" };
    if (mode !== "auto") return { decision: "ask" };

    const classified = await classify();
    if (classified.decision === "deny") {
        return { decision: "deny", reason: REASON_AUTO_MODE_DENIED, notify: classified.reason };
    }
    return classified;
}
