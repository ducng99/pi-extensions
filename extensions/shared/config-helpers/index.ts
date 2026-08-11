import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ============================================================================
// Config File Paths
// ============================================================================

function getHomeDir(): string {
    return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

export function globalClaudeSettingsPath(): string {
    return join(getHomeDir(), ".claude", "settings.json");
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
