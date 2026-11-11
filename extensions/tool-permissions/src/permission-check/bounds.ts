import { isOutOfBoundsPath } from "./paths";

/** Tools that operate on file paths */
export const FILE_PATH_TOOLS = new Set(["edit", "write", "patch", "read"]);

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
    if (!FILE_PATH_TOOLS.has(toolName)) return false;

    const filePath = input.path as string;
    if (!filePath) return false;
    return isOutOfBoundsPath(filePath, cwd, cwd, additionalDirs);
}
