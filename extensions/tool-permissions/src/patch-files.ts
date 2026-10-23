/**
 * Helpers for the `patch` tool, whose input is `{ files: [{ path, patch }, ...] }`.
 * Permission checks treat every file as its own single-file `{ path, patch }` call.
 */

/** Return the `{ path, patch }` entries of a patch tool input (empty when malformed). */
export function getPatchFiles(input: Record<string, unknown>): { path: string; patch: string }[] {
    const files = input.files;
    if (!Array.isArray(files)) return [];
    const out: { path: string; patch: string }[] = [];
    for (const f of files) {
        if (f && typeof f === "object" && typeof (f as { path?: unknown }).path === "string") {
            const { path, patch } = f as { path: string; patch?: unknown };
            out.push({ path, patch: typeof patch === "string" ? patch : "" });
        }
    }
    return out;
}

/**
 * Split a tool call into per-file calls. Non-patch tools (and patch calls that
 * already use a single top-level `path`) are returned unchanged.
 */
export function expandToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown>[] {
    if (toolName !== "patch" || !Array.isArray(input.files)) return [input];
    return getPatchFiles(input).map(f => ({ path: f.path, patch: f.patch }));
}

/** Paths touched by a patch tool call (or the single `path` of other file tools). */
export function getTouchedPaths(toolName: string, input: Record<string, unknown>): string[] {
    if (toolName === "patch" && Array.isArray(input.files)) return getPatchFiles(input).map(f => f.path);
    return typeof input.path === "string" ? [input.path] : [];
}
