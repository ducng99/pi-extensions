import { homedir } from "os";
import { isAbsolute, normalize, relative, resolve, sep } from "path";

/**
 * Resolve a directory path relative to cwd, expanding ~ to the home directory.
 */
function resolveDir(dir: string, cwd: string): string {
    if (dir === "~") {
        return normalize(homedir());
    }
    if (dir.startsWith("~/") || dir.startsWith("~\\")) {
        return normalize(resolve(homedir(), dir.slice(2)));
    }
    return normalize(resolve(cwd, dir));
}

/**
 * Resolve a command argument path relative to cwd, expanding ~ to home.
 */
export function resolveArgPath(path: string, cwd: string): string {
    if (path === "~") {
        return normalize(homedir());
    }
    if (path.startsWith("~/") || path.startsWith("~\\")) {
        return normalize(resolve(homedir(), path.slice(2)));
    }
    return normalize(resolve(cwd, path));
}

/**
 * Check whether a resolved path is inside a given directory.
 *
 * Uses `path.relative` instead of raw prefix matching so it works with both
 * `/` and `\` separators (Windows) and compares case-insensitively on Windows
 * (e.g. `C:\Foo` vs `c:\foo`).
 */
export function isInsideDir(resolvedPath: string, dir: string): boolean {
    const normalizedDir = normalize(resolve(dir));
    const rel = relative(normalizedDir, resolvedPath);
    // Equal paths (or case-variant equal on Windows) → inside.
    if (rel === "") return true;
    // Escaping the dir yields `..` or `..<sep>...`; on Windows, paths on
    // different drives yield an absolute relative path (e.g. `D:\...`).
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Check whether a resolved path is inside a sensitive project directory
 * (`<boundaryCwd>/.pi`, `<boundaryCwd>/.claude`, or `<boundaryCwd>/.mcp.json`). Accessing these paths via
 * read/edit/write can allow an agent to modify its own permission rules.
 *
 * The plan subdirectories (`<boundaryCwd>/.pi/plans` and
 * `<boundaryCwd>/.claude/plans`) are exempt: they only hold the agent's own
 * working notes, not permission rules, so they are not sensitive.
 */
export function isSensitivePath(resolvedPath: string, boundaryCwd: string): boolean {
    const sensitiveDirs = [".pi", ".claude"];
    const boundary = normalize(resolve(boundaryCwd));
    for (const dir of sensitiveDirs) {
        const sensitiveDir = normalize(resolve(boundary, dir));
        if (!isInsideDir(resolvedPath, sensitiveDir)) continue;
        if (isInsideDir(resolvedPath, normalize(resolve(boundary, dir, "plans")))) continue;
        return true;
    }
    return false;
}

/**
 * Check if a single path is outside the allowed boundary and all additional
 * directories.
 *
 * `resolveCwd` and `boundaryCwd` are deliberately distinct: `resolveCwd` is
 * only used to resolve *relative* path arguments (e.g. the effective cwd
 * after tracking `cd`s within a command chain), while `boundaryCwd` (and
 * `additionalDirs`) is the fixed set of directories the path must land
 * inside. Using the effective cwd as the boundary too would incorrectly flag
 * `cd ../..` as out-of-bounds when it merely returns to the original
 * (allowed) session cwd after having `cd`'d into a subdirectory.
 */
export function isOutOfBoundsPath(path: string, resolveCwd: string, boundaryCwd: string, additionalDirs: string[]): boolean {
    const resolvedPath = resolveArgPath(path, resolveCwd);
    const resolvedBoundaryCwd = normalize(resolve(boundaryCwd));

    if (isInsideDir(resolvedPath, resolvedBoundaryCwd)) return false;

    for (const dir of additionalDirs) {
        if (isInsideDir(resolvedPath, resolveDir(dir, boundaryCwd))) return false;
    }

    return true;
}
