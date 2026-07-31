// ============================================================================
// JSONC Comment Stripping
// ============================================================================

export function stripJsoncComments(raw: string): string {
  // Remove single-line comments (// ...) — be careful not to strip inside strings
  return raw
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}
