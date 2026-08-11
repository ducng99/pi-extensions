import { existsSync, readFileSync } from "fs";

import {
    globalClaudeSettingsPath,
    projectClaudeLocalSettingsPath,
    projectClaudeSettingsPath,
} from "../../shared/config-helpers/index";
import { stripJsoncComments } from "../../shared/jsonc-utils/index";
import { parseClaudePerms, type ParsedPermissions } from "./permission-parsing";

// ============================================================================
// Settings Loading & Merging
// ============================================================================

interface LoadedSettings {
    permissions: ParsedPermissions;
    source: string;
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
        // Subagent extensions generate a Claude-style settings.json file.
        return { permissions: parseClaudePerms(content), source: envPath };
    }
    catch {
        return null;
    }
}

// ============================================================================
// Plan-mode permissions (set by the plan extension via the event bus)
// ============================================================================

let planModePermissions: ParsedPermissions | null = null;

/**
 * Set (or clear) the active plan-mode permission set. The plan extension emits
 * `plan_mode:activated` / `plan_mode:deactivated` on the event bus; the tool
 * permissions extension forwards those into here.
 */
export function setPlanModePermissions(permissions: ParsedPermissions | null): void {
    planModePermissions = permissions;
}

function loadPlanModePermissions(): LoadedSettings | null {
    if (!planModePermissions) return null;
    return { permissions: planModePermissions, source: "plan-mode" };
}

export function collectAllSettings(cwd: string): ParsedPermissions[] {
    const all: ParsedPermissions[] = [];

    // Load all claude settings
    const globalClaude = loadJsonFile(globalClaudeSettingsPath());
    if (globalClaude) all.push(globalClaude.permissions);

    const projectClaude = projectClaudeSettingsPath(cwd);
    if (projectClaude) {
        const loaded = loadJsonFile(projectClaude);
        if (loaded) all.push(loaded.permissions);
    }

    const projectClaudeLocal = projectClaudeLocalSettingsPath(cwd);
    if (projectClaudeLocal) {
        const loaded = loadJsonFile(projectClaudeLocal);
        if (loaded) all.push(loaded.permissions);
    }

    // Subagent permissions file (if set) is merged last so it takes highest
    // precedence while still respecting deny > ask > allow within the merged set.
    const subagent = loadSubagentPermissionsFile();
    if (subagent) all.push(subagent.permissions);

    // Plan-mode permissions (while /plan is active) are merged last too, so the
    // plan-mode deny rules take precedence over the user's own settings.
    const planMode = loadPlanModePermissions();
    if (planMode) all.push(planMode.permissions);

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
