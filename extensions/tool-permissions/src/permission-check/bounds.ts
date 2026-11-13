import { isOutOfBoundsPath, resolveArgPath } from "./paths";

/** Tools that operate on file paths */
export const FILE_PATH_TOOLS = new Set(["edit", "write", "patch", "read"]);

/**
 * Resolve the file path a tool call is accessing when it lies outside cwd and
 * all additional directories. Returns the resolved path, or null when the
 * access is in-bounds (or the tool does not operate on file paths).
 */
export function getOutOfBoundsPath(
    toolName: string,
    input: Record<string, unknown>,
    cwd: string,
    additionalDirs: string[],
): string | null {
    if (!FILE_PATH_TOOLS.has(toolName)) return null;

    const filePath = input.path as string;
    if (!filePath) return null;
    if (!isOutOfBoundsPath(filePath, cwd, cwd, additionalDirs)) return null;
    return resolveArgPath(filePath, cwd);
}

/**
 * Check if the tool is accessing a file outside cwd and all additional directories.
 * Returns true if the access is out-of-bounds.
 */
export function isOutOfBounds(
    toolName: string,
    input: Record<string, unknown>,
    cwd: string,
    additionalDirs: string[],
): boolean {
    return getOutOfBoundsPath(toolName, input, cwd, additionalDirs) !== null;
}
