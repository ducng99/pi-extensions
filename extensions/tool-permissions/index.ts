/**
 * Tool Permissions Extension
 *
 * Intercepts tool calls and checks them against permission rules loaded from:
 * - claude settings.json (global: ~/.claude/settings.json)
 * - claude settings.json (project-local: .claude/settings.json)
 * - claude settings.local.json (project-local, higher priority: .claude/settings.local.json)
 * - opencode.jsonc (global: ~/.config/opencode/opencode.jsonc)
 * - opencode.jsonc (project-local: .opencode/opencode.json[rc])
 *
 * Priority: If ANY claude settings exist, ONLY claude settings are used.
 * Claude and opencode settings are never merged together.
 * Within each format, settings are merged with deny > ask > allow priority.
 * If a tool is not in any list, it defaults to "ask".
 * edit and write tools are merged under the "edit" permission category.
 */

import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

import { initParser } from "../shared/bash-parser/index";
import { type PermissionResult, PermissionSelector } from "../shared/tui-components/index";
import { formatConfirmMessage } from "./src/confirmation-message";
import { checkPermission } from "./src/permission-check";
import { collectAllSettings, mergePermissions } from "./src/settings-loading";
import { TOOL_CATEGORY } from "./src/tool-categories";

// ============================================================================
// Parser Initialization
// ============================================================================

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
    // Initialize parser eagerly at startup
    ensureParserInitialized().catch((err) => {
        console.error("Failed to initialize tree-sitter parser:", err);
    });

    pi.on("tool_call", async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | void> => {
        const toolName = event.toolName;

        // Only intercept tools we have category mappings for
        const category = TOOL_CATEGORY[toolName];
        if (!category) return undefined;

        // Ensure parser is initialized before checking permissions
        await ensureParserInitialized();

        // Collect and merge permissions (cache-friendly — loads on every call,
        // but file reads are fast for config files)
        const allSettings = collectAllSettings(ctx.cwd);
        const merged = mergePermissions(allSettings);

        const decision = checkPermission(toolName, event.input as Record<string, unknown>, merged, ctx.cwd);

        if (decision.decision === "deny") {
            return {
                block: true,
                reason: `${toolName} is denied by your permission settings.`,
            };
        }

        if (decision.decision === "ask") {
            const result = await ctx.ui.custom<PermissionResult>((tui, theme, keybindings, done) => {
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

            ctx.abort();
            return {
                block: true,
                reason: `${toolName} was denied by user.`,
            };
        }

        // "allow" — proceed with execution
        return undefined;
    });
}
