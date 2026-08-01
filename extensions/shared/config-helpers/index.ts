import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ============================================================================
// Config File Paths
// ============================================================================

export function globalOpencodePath(): string {
    return join(homedir(), ".config", "opencode", "opencode.jsonc");
}

export function projectOpencodePath(cwd: string): string | null {
    const jsonc = join(cwd, ".opencode", "opencode.jsonc");
    const json = join(cwd, ".opencode", "opencode.json");
    if (existsSync(jsonc)) return jsonc;
    if (existsSync(json)) return json;
    return null;
}

export function globalClaudeSettingsPath(): string {
    return join(homedir(), ".claude", "settings.json");
}

export function projectClaudeSettingsPath(cwd: string): string | null {
    const path = join(cwd, ".claude", "settings.json");
    if (existsSync(path)) return path;
    return null;
}

export function projectClaudeLocalSettingsPath(cwd: string): string | null {
    const path = join(cwd, ".claude", "settings.local.json");
    if (existsSync(path)) return path;
    return null;
}
