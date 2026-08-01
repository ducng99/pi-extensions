import { existsSync, readFileSync } from "fs";

import {
    globalClaudeSettingsPath,
    globalOpencodePath,
    projectClaudeLocalSettingsPath,
    projectClaudeSettingsPath,
    projectOpencodePath,
} from "../../shared/config-helpers/index";
import { stripJsoncComments } from "../../shared/jsonc-utils/index";
import { parseClaudePerms, type ParsedPermissions, parseOpencodePerms } from "./permission-parsing";

// ============================================================================
// Settings Loading & Merging
// ============================================================================

interface LoadedSettings {
    permissions: ParsedPermissions;
    source: string;
}

function loadJsoncFile(path: string): LoadedSettings | null {
    if (!existsSync(path)) return null;
    try {
        const content = readFileSync(path, "utf-8");
        return { permissions: parseOpencodePerms(content), source: path };
    }
    catch {
        return null;
    }
}

function loadJsonFile(path: string): LoadedSettings | null {
    if (!existsSync(path)) return null;
    try {
        const content = readFileSync(path, "utf-8");
        return { permissions: parseClaudePerms(content), source: path };
    }
    catch {
        return null;
    }
}

function loadSubagentPermissionsFile(): LoadedSettings | null {
    const envPath = process.env["PI_SUBAGENT_PERMISSIONS_FILE"];
    if (!envPath) return null;
    if (!existsSync(envPath)) return null;
    try {
        const content = stripJsoncComments(readFileSync(envPath, "utf-8"));
        // Subagent extensions generate a Claude-style settings.json file. If the
        // file contains opencode-style keys and no Claude-style keys, fall back
        // to the opencode parser.
        const permissions = content.includes('"permission"') && !content.includes('"permissions"')
            ? parseOpencodePerms(content)
            : parseClaudePerms(content);
        return { permissions, source: envPath };
    }
    catch {
        return null;
    }
}

export function collectAllSettings(cwd: string): ParsedPermissions[] {
    const all: ParsedPermissions[] = [];

    // Load all claude settings
    const globalClaude = loadJsonFile(globalClaudeSettingsPath());
    const projectClaude = projectClaudeSettingsPath(cwd);
    const projectClaudeLocal = projectClaudeLocalSettingsPath(cwd);

    // If ANY claude settings exist, use ONLY claude settings (ignore opencode)
    if (globalClaude || projectClaude || projectClaudeLocal) {
        if (globalClaude) all.push(globalClaude.permissions);
        if (projectClaude) {
            const loaded = loadJsonFile(projectClaude);
            if (loaded) all.push(loaded.permissions);
        }
        if (projectClaudeLocal) {
            const loaded = loadJsonFile(projectClaudeLocal);
            if (loaded) all.push(loaded.permissions);
        }
    }
    else {
        // No claude settings — fall back to opencode settings
        const globalOpencode = loadJsoncFile(globalOpencodePath());
        if (globalOpencode) all.push(globalOpencode.permissions);

        const projectOpencode = projectOpencodePath(cwd);
        if (projectOpencode) {
            const loaded = loadJsoncFile(projectOpencode);
            if (loaded) all.push(loaded.permissions);
        }
    }

    // Subagent permissions file (if set) is merged last so it takes highest
    // precedence while still respecting deny > ask > allow within the merged set.
    const subagent = loadSubagentPermissionsFile();
    if (subagent) all.push(subagent.permissions);

    return all;
}

export function mergePermissions(allSettings: ParsedPermissions[]): ParsedPermissions {
    const merged: ParsedPermissions = { allow: [], ask: [], deny: [], additionalDirectories: [] };
    for (const setting of allSettings) {
        merged.allow.push(...setting.allow);
        merged.ask.push(...setting.ask);
        merged.deny.push(...setting.deny);
        if (setting.additionalDirectories) {
            merged.additionalDirectories!.push(...setting.additionalDirectories);
        }
    }
    return merged;
}
