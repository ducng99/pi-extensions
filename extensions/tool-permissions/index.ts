/**
 * Tool Permissions Extension
 *
 * Intercepts tool calls and checks them against permission rules loaded from:
 * - claude settings.json (global: ~/.claude/settings.json)
 * - claude settings.json (project-local: .claude/settings.json)
 * - claude settings.local.json (project-local, higher priority: .claude/settings.local.json)
 * - subagent permissions file (PI_SUBAGENT_PERMISSIONS_FILE)
 * - plan-mode permissions (while the plan extension's /plan is active)
 *
 * Priority: Settings are merged with deny > ask > allow priority.
 * If a tool is not in any list, it defaults to "ask".
 * edit and write tools are merged under the "edit" permission category.
 *
 * Plan-mode permissions are merged last (like the subagent file) so the
 * plan-mode deny rules take precedence over the user's own settings.
 */

import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

import { initParser } from "../shared/bash-parser/index";
import { type PermissionResult, PermissionSelector } from "../shared/tui-components/index";
import { loadClassifier } from "./src/classifier";
import { formatConfirmMessage } from "./src/confirmation-message";
import { checkPermission } from "./src/permission-check";
import type { ParsedPermissions } from "./src/permission-parsing";
import { buildSessionContext } from "./src/session-context";
import { collectAllSettings, mergePermissions, setPlanModePermissions } from "./src/settings-loading";

let parserInitialized = false;
let initPromise: Promise<void> | null = null;

async function ensureParserInitialized(): Promise<void> {
    if (parserInitialized) return;

    if (!initPromise) {
        initPromise = initParser().then(() => {
            parserInitialized = true;
        });
    }

    return initPromise;
}

// ============================================================================
// Extension Factory
// ============================================================================

export default function (pi: ExtensionAPI) {
    let automodeEnabled = false;

    // Forward plan-mode toggling from the plan extension (over the shared event
    // bus) into the settings loader, which merges them like the subagent file.
    pi.events.on("plan_mode:activated", (data) => {
        setPlanModePermissions(data as ParsedPermissions);
    });
    pi.events.on("plan_mode:deactivated", () => {
        setPlanModePermissions(null);
    });

    // Initialize parser eagerly at startup
    ensureParserInitialized().catch((err) => {
        console.error("Failed to initialize tree-sitter parser:", err);
    });

    pi.on("tool_call", async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | void> => {
        const toolName = event.toolName;

        // Ensure parser is initialized before checking permissions
        await ensureParserInitialized();

        // Collect and merge permissions (cache-friendly — loads on every call,
        // but file reads are fast for config files)
        const allSettings = collectAllSettings(ctx.cwd);
        const merged = mergePermissions(allSettings);

        // Derive the classifier's session context lazily (only built when the
        // bash classifier is actually consulted). `getEntries()` is the session
        // source of truth and already excludes the in-flight tool call (it
        // hasn't been appended yet), so no self-exclusion logic is needed.
        const decision = await checkPermission(
            toolName,
            event.input as Record<string, unknown>,
            merged,
            ctx.cwd,
            () => automodeEnabled,
            ctx.signal,
            () => buildSessionContext(ctx.sessionManager.getEntries(), ctx.cwd, pi.exec),
        );

        if (decision.decision === "deny") {
            return {
                block: true,
                reason: `${toolName} is denied by your permission settings.`,
            };
        }

        if (decision.decision === "ask") {
            const result = await ctx.ui.custom<PermissionResult>((_tui, theme, _keybindings, done) => {
                const contextMsg = formatConfirmMessage(theme, toolName, event.input as Record<string, unknown>, ctx.cwd, decision.reason);
                const title = `${contextMsg}\n\nAllow ${toolName}?`;

                return new PermissionSelector(title, done);
            });

            if (result?.allow) {
                return undefined;
            }

            if (result?.message) {
                return {
                    block: true,
                    reason: `User denied ${toolName}: ${result.message}`,
                };
            }

            return {
                block: true,
                reason: `${toolName} was denied by user.`,
                terminate: true,
            };
        }

        if (decision.decision === "allow" && decision.reason) {
            ctx.ui.notify(decision.reason, "info");
        }

        // "allow" — proceed with execution
        return undefined;
    });

    pi.registerCommand("automode", {
        description: "Toggle auto mode for checking bash commands",
        async handler(_, ctx) {
            try {
                automodeEnabled = !automodeEnabled;
                if (automodeEnabled) {
                    await loadClassifier(ctx.modelRegistry);
                }

                ctx.ui.setStatus("STATUS_AUTOMODE_ENABLED", automodeEnabled ? ctx.ui.theme.fg("warning", "⏵⏵ auto mode on") : undefined);
            }
            catch (err) {
                ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
            }
        },
    });
}
