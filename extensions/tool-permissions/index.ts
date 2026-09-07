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
import { type PermissionResult, PermissionSelector, type PermissionSelectorOption } from "../shared/tui-components/index";
import { loadClassifier } from "./src/classifier";
import { formatConfirmMessage } from "./src/confirmation-message";
import { checkPermission } from "./src/permission-check";
import type { ParsedPermissions } from "./src/permission-parsing";
import { SessionAllowlist } from "./src/session-allowlist";
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
    let automodeEnabled = true;

    // Per-session memoization of "Yes, allow this session" approvals. Lives
    // for the lifetime of this extension instance (one pi process); the
    // extension factory is re-entered on every session_start, so the set is
    // naturally reset between sessions.
    const sessionAllowlist = new SessionAllowlist();

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

    // Show auto mode status indicator on session start
    pi.on("session_start", (_, ctx) => {
        if (automodeEnabled) {
            loadClassifier(ctx.modelRegistry).catch(() => {});
        }
        ctx.ui.setStatus("STATUS_AUTOMODE_ENABLED", automodeEnabled ? ctx.ui.theme.fg("warning", "⏵⏵ auto mode on") : undefined);
    });

    pi.on("tool_call", async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | void> => {
        const toolName = event.toolName;
        const input = event.input as Record<string, unknown>;

        // Session-scoped approvals: a prior "Yes, allow this session" decision
        // skips both the permission check and the prompt. Bash commands are
        // excluded from this fast path because each invocation is independent
        // (different command strings) and a session-wide allow for `bash` would
        // be too coarse to be useful.
        if (toolName !== "bash" && sessionAllowlist.allows(toolName, input)) {
            return undefined;
        }

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
            input,
            merged,
            ctx.cwd,
            () => automodeEnabled,
            ctx.signal,
            () => buildSessionContext(ctx.sessionManager.getEntries(), ctx.cwd, pi.exec),
        );

        if (decision.decision === "deny") {
            return {
                block: true,
                reason: decision.reason ?? `${toolName} is denied by your permission settings.`,
            };
        }

        if (decision.decision === "ask") {
            // Try the rich TUI custom component first. If custom() is not
            // supported (e.g. RPC mode used by subagents), fall back to the
            // simpler confirm() dialog which is forwarded to the parent session
            // via the extension_ui_request/extension_ui_response protocol.
            const customResult = await ctx.ui.custom<PermissionResult>((tui, theme, _keybindings, done) => {
                const contextMsg = formatConfirmMessage(theme, toolName, input, ctx.cwd, decision.reason);
                const question = `Allow ${toolName}?`;
                const rows = tui.terminal.rows;

                // Three-option layout (Yes / Yes, allow this session / No) for
                // every non-bash tool. Bash is omitted because each command is
                // independent — a session-wide "allow" for `bash` would be
                // ambiguous and is left as the default two-option prompt.
                const options: PermissionSelectorOption[] = toolName === "bash"
                    ? [
                            { label: "Yes", kind: "allow" },
                            { label: "No", kind: "denyWithMessage" },
                        ]
                    : [
                            { label: "Yes", kind: "allow" },
                            { label: "Yes, allow this session", kind: "allowSession" },
                            { label: "No", kind: "denyWithMessage" },
                        ];

                return new PermissionSelector(contextMsg, question, done, {
                    maxTitleLines: Math.max(4, Math.min(12, Math.floor(rows * 0.35))),
                    terminalRows: rows,
                    options,
                });
            }, {
                overlay: true,
                overlayOptions: {
                    row: "100%",
                    width: "100%",
                    margin: { top: 1, bottom: 1 },
                },
            });

            if (customResult !== undefined) {
                if (customResult.allow) {
                    if (customResult.allowSession) {
                        // Remember this tool/argument pair so subsequent matching
                        // calls in the same session skip the prompt entirely.
                        sessionAllowlist.add(toolName, input);
                    }
                    return undefined;
                }
                if (customResult.message) {
                    return {
                        block: true,
                        reason: `User denied ${toolName}: ${customResult.message}`,
                    };
                }
                return {
                    block: true,
                    reason: `${toolName} was denied by user.`,
                    terminate: true,
                };
            }

            // Fallback: confirm() works in both TUI and RPC modes. In RPC
            // mode it emits extension_ui_request → parent forwards to main
            // session UI → extension_ui_response resolves the promise. It only
            // supports yes/no, so the "allow this session" option is not
            // surfaced here; users wanting session-scope can still rely on the
            // TUI prompt, or add an explicit allow rule.
            const contextMsg = formatConfirmMessage(ctx.ui.theme, toolName, input, ctx.cwd, decision.reason, ctx.hasUI);
            const allowed = await ctx.ui.confirm(
                `Allow ${toolName}?`,
                contextMsg,
            );

            if (allowed) {
                return undefined;
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
