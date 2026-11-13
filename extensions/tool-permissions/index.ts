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

import type { ExtensionAPI, Theme, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

import { initParser } from "../shared/bash-parser/index";
import { type PermissionResult, PermissionSelector, type PermissionSelectorOption } from "../shared/tui-components/index";
import { loadClassifier } from "./src/classifier";
import { setIntentFiles as setClassifierIntentFiles } from "./src/classifier/systemone";
import { formatConfirmMessage } from "./src/confirmation-message";
import { checkPermission, type PermissionMode } from "./src/permission-check";
import type { ParsedPermissions } from "./src/permission-parsing";
import { SessionAllowlist } from "./src/session-allowlist";
import { buildSessionContext, type ExecFn } from "./src/session-context";
import { collectAllSettings, getRemoteSession, mergePermissions, setPlanModePermissions, setRemoteSession } from "./src/settings-loading";

let parserInitialized = false;
let initPromise: Promise<void> | null = null;
let permissionMode: PermissionMode = "auto";

/**
 * Status text for the active permission mode: yellow for auto mode, red for
 * allow mode, none when off.
 */
function modeStatusText(theme: Theme): string | undefined {
    switch (permissionMode) {
        case "auto":
            return theme.fg("warning", "⏵⏵ auto mode on");
        case "allow":
            return theme.fg("error", "⏵⏵ allow mode on");
        default:
            return undefined;
    }
}

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

    // Forward remote connections from the remote extension: while active, the
    // path boundary and the classifier's git context switch to the remote
    // machine, and the remote project's claude settings are merged in.
    pi.events.on("remote:connected", (data) => {
        const d = data as { remoteCwd: string; exec: ExecFn };
        setRemoteSession({ remoteCwd: d.remoteCwd, exec: d.exec });
    });
    pi.events.on("remote:disconnected", () => {
        setRemoteSession(null);
    });

    // Feed the session's pre-loaded instruction files (AGENTS.md / CLAUDE.md)
    // to the LLM classifier as user intent — Claude Code sends CLAUDE.md to
    // its auto mode classifier the same way. Refreshed every turn.
    pi.on("before_agent_start", (event) => {
        setClassifierIntentFiles(event.systemPromptOptions.contextFiles);
    });

    // Initialize parser eagerly at startup
    ensureParserInitialized().catch((err) => {
        console.error("Failed to initialize tree-sitter parser:", err);
    });

    // Show permission mode status indicator on session start
    pi.on("session_start", (_, ctx) => {
        if (permissionMode === "auto") {
            loadClassifier(ctx.modelRegistry).catch(() => {});
        }
        ctx.ui.setStatus("STATUS_PERMISSION_MODE", modeStatusText(ctx.ui.theme));
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

        // While a remote session is active, paths are checked against the
        // remote working directory instead of the local one.
        const remote = getRemoteSession();
        const boundaryCwd = remote?.remoteCwd ?? ctx.cwd;

        // Collect and merge permissions (cache-friendly — loads on every call,
        // but file reads are fast for config files; remote settings are
        // fetched once per connection)
        const allSettings = await collectAllSettings(ctx.cwd);
        const merged = mergePermissions(allSettings);

        // Derive the classifier's session context lazily (only built when the
        // bash classifier is actually consulted). `getEntries()` is the session
        // source of truth and already excludes the in-flight tool call (it
        // hasn't been appended yet), so no self-exclusion logic is needed.
        const decision = await checkPermission(
            toolName,
            input,
            merged,
            boundaryCwd,
            () => permissionMode,
            ctx.signal,
            () => buildSessionContext(ctx.sessionManager.getEntries(), boundaryCwd, remote?.exec ?? pi.exec),
            () => ctx.sessionManager.getEntries(),
            path => sessionAllowlist.allowsOutOfBoundsPath(path),
        );

        if (decision.decision === "deny") {
            if (decision.notify) {
                ctx.ui.notify(decision.notify, "info");
            }
            return {
                block: true,
                reason: decision.reason ?? `${toolName} is denied by your permission settings.`,
            };
        }

        if (decision.decision === "ask") {
            const outOfBoundsPath = decision.outOfBoundsPath;

            // Try the rich TUI custom component first. If custom() is not
            // supported (e.g. RPC mode used by subagents), fall back to the
            // simpler confirm() dialog which is forwarded to the parent session
            // via the extension_ui_request/extension_ui_response protocol.
            const customResult = await ctx.ui.custom<PermissionResult>((tui, theme, _keybindings, done) => {
                const contextMsg = formatConfirmMessage(theme, toolName, input, boundaryCwd, decision.reason);
                const question = `Allow ${toolName}?`;
                const rows = tui.terminal.rows;
                const allowSessionLabel = outOfBoundsPath
                    ? `Yes, allow this session for ${outOfBoundsPath}`
                    : "Yes, allow this session";

                // Out-of-bounds asks always offer the session-scoped allow: for
                // file tools it keys the exact tool+path pair, while for bash
                // the approved path itself is remembered (a whole command
                // string would be too coarse). Other bash asks stay two-option
                // because a session-wide allow for `bash` would be ambiguous.
                const sessionOptionAllowed = Boolean(outOfBoundsPath) || toolName !== "bash";
                const options: PermissionSelectorOption[] = sessionOptionAllowed
                    ? [
                            { label: "Yes", kind: "allow" },
                            { label: allowSessionLabel, kind: "allowSession" },
                            { label: "No", kind: "denyWithMessage" },
                        ]
                    : [
                            { label: "Yes", kind: "allow" },
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
                        // Out-of-bounds approvals are additionally scoped to the
                        // checked path, which is what bash decisions re-check.
                        sessionAllowlist.add(toolName, input);
                        if (outOfBoundsPath) {
                            sessionAllowlist.addOutOfBoundsPath(outOfBoundsPath);
                        }
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
            const contextMsg = formatConfirmMessage(ctx.ui.theme, toolName, input, boundaryCwd, decision.reason, ctx.hasUI);
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

        if (decision.decision === "allow" && (decision.notify ?? decision.reason)) {
            ctx.ui.notify(decision.notify ?? decision.reason!, "info");
        }

        // "allow" — proceed with execution
        return undefined;
    });

    pi.registerCommand("automode", {
        description: "Cycle permission mode (auto → allow → off)",
        async handler(_, ctx) {
            try {
                permissionMode = permissionMode === "auto" ? "allow" : permissionMode === "allow" ? "off" : "auto";
                if (permissionMode === "auto") {
                    await loadClassifier(ctx.modelRegistry);
                }

                ctx.ui.setStatus("STATUS_PERMISSION_MODE", modeStatusText(ctx.ui.theme));
            }
            catch (err) {
                ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
            }
        },
    });
}
