import { existsSync, readFileSync } from "fs";

import {
    globalClaudeSettingsPath,
    projectClaudeLocalSettingsPath,
    projectClaudeSettingsPath,
} from "../../shared/config-helpers/index";
import { stripJsoncComments } from "../../shared/jsonc-utils/index";
import { parseClaudePerms, type ParsedPermissions } from "./permission-parsing";
import type { ExecFn } from "./session-context";

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
// Remote session (set by the remote extension via the event bus)
// ============================================================================

/**
 * While the remote extension's /remote connect is active, this holds the
 * remote working directory and an SSH-backed exec function. Path boundaries
 * resolve against the remote cwd, and the remote project's own claude settings
 * are fetched over SSH and merged.
 */
export interface RemotePermissionSession {
    remoteCwd: string;
    exec: ExecFn;
}

let remoteSession: RemotePermissionSession | null = null;
// undefined = not loaded yet for this connection; null = connection has no remote settings.
let remoteSettingsCache: ParsedPermissions | null | undefined;

export function setRemoteSession(session: RemotePermissionSession | null): void {
    remoteSession = session;
    remoteSettingsCache = undefined;
}

export function getRemoteSession(): RemotePermissionSession | null {
    return remoteSession;
}

async function readRemoteTextFile(path: string): Promise<string | null> {
    if (!remoteSession) return null;
    try {
        const res = await remoteSession.exec("cat", [path], { timeout: 15 });
        return res.code === 0 ? res.stdout : null;
    }
    catch {
        return null;
    }
}

/**
 * Fetch the remote project's claude settings over SSH. Cached for the lifetime
 * of the connection (invalidate via setRemoteSession). Returns null when the
 * connection has no remote settings files at all.
 */
async function loadRemoteProjectSettings(): Promise<ParsedPermissions | null> {
    if (!remoteSession) return null;
    if (remoteSettingsCache !== undefined) return remoteSettingsCache;

    const merged: ParsedPermissions = { allow: [], ask: [], deny: [], additionalDirectories: [] };
    let found = false;
    for (const name of ["settings.json", "settings.local.json"]) {
        const content = await readRemoteTextFile(`${remoteSession.remoteCwd}/.claude/${name}`);
        if (content === null) continue;
        found = true;
        const parsed = parseClaudePerms(stripJsoncComments(content));
        merged.allow.push(...parsed.allow);
        merged.ask.push(...parsed.ask);
        merged.deny.push(...parsed.deny);
        if (parsed.additionalDirectories) {
            merged.additionalDirectories!.push(...parsed.additionalDirectories);
        }
    }
    remoteSettingsCache = found ? merged : null;
    return remoteSettingsCache;
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

export async function collectAllSettings(cwd: string): Promise<ParsedPermissions[]> {
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

    // Remote project settings (while /remote connect is active) merge after the
    // local ones: rules on the machine being edited take precedence.
    const remote = await loadRemoteProjectSettings();
    if (remote) all.push(remote);

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
