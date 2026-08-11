/**
 * Plan Extension
 *
 * `/plan` toggles a read-only "plan mode". In plan mode the active tool set is
 * restricted to read-only exploration tools plus the `write_plan` / `edit_plan`
 * tools, and tool-permissions is told (via the shared `pi.events` bus) to gate
 * every intercepted tool against the plan-mode permission set.
 *
 * After a plan is written or edited, the plan is rendered inline above a
 * "what next?" prompt (implement it, clear and restart, or keep chatting).
 * The tools themselves use pi's default tool-row rendering.
 *
 * Plan mode is in-memory only. Every session starts with plan mode off.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEditToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { readFile } from "fs/promises";
import { join } from "path";

import { createPlanPrompt } from "./renderer";
import type { PlanDetails } from "./schema";
import { EditPlanParams, WritePlanParams } from "./schema";
import { PLAN_MODE_PERMISSIONS, PLAN_TOOL_NAMES, PLAN_WRITE_TOOLS } from "./tools";
import { normalizePlanFilename, plansDir } from "./utils";

const STATUS_PLAN_MODE = "status:plan_mode";

export default function planExtension(pi: ExtensionAPI) {
    // In-memory state. Always starts false for every session.
    let planModeActive = false;
    let toolsBeforePlanMode: string[] = [];

    function deactivatePlanMode(ctx: ExtensionContext): void {
        if (!planModeActive) return;
        planModeActive = false;
        pi.setActiveTools(toolsBeforePlanMode);
        toolsBeforePlanMode = [];
        pi.events.emit("plan_mode:deactivated", {});
        ctx.ui.setStatus(STATUS_PLAN_MODE, undefined);

        pi.sendMessage({
            customType: "plan",
            content: "Plan mode disabled. Full access restored.",
            display: true,
        });
    }

    function togglePlanMode(ctx: ExtensionContext): void {
        if (planModeActive) {
            deactivatePlanMode(ctx);
            return;
        }

        toolsBeforePlanMode = pi.getActiveTools();
        pi.setActiveTools([...PLAN_TOOL_NAMES]);
        planModeActive = true;
        pi.events.emit("plan_mode:activated", PLAN_MODE_PERMISSIONS);
        ctx.ui.setStatus(STATUS_PLAN_MODE, ctx.ui.theme.fg("dim", "⏸ plan mode on"));

        pi.sendMessage({
            customType: "plan",
            content: "Plan mode enabled. Only read-only tools and plan writing are allowed.",
            display: true,
        });
    }

    // No state persistence: every session starts with plan mode off.
    pi.on("session_start", (_, ctx) => {
        if (planModeActive) deactivatePlanMode(ctx);
    });

    pi.on("tool_result", async (event, ctx) => {
        if (!planModeActive || !PLAN_WRITE_TOOLS.has(event.toolName) || !ctx.hasUI) return;

        const first = event.content?.[0];
        const content = first?.type === "text" ? first.text : "";
        const filename = (event.details as PlanDetails | undefined)?.filename ?? "";

        const options = [
            "Implement now — exit plan mode and continue working",
            "Clear & implement — start fresh (not yet implemented)",
            "Chat more — stay in plan mode and keep chatting",
        ];

        // TUI: show the plan (Markdown) above a SelectList of next steps, as a
        // fullscreen overlay. The component is removed from the UI as soon as
        // the user answers.
        const choice = ctx.mode === "tui"
            ? await ctx.ui.custom<string>(
                    (tui, theme, _keybindings, done) =>
                        createPlanPrompt(filename, content, {
                            tui,
                            theme,
                            isError: event.isError,
                            done,
                        }),
                    {
                        overlay: true,
                        overlayOptions: {
                            width: "100%",
                            maxHeight: "100%",
                            margin: 0,
                            anchor: "top-left",
                        },
                    },
                )
            : await ctx.ui.select("Plan ready — what next?", options);

        if (choice?.startsWith("Implement now")) {
            deactivatePlanMode(ctx);
            pi.sendUserMessage("Implement the plan now.", { deliverAs: "followUp" });
        }
        else if (choice?.startsWith("Clear & implement")) {
            ctx.ui.notify("Clear & implement: not yet implemented.", "warning");
        }
        else {
            ctx.abort();
        }
        // "Chat more": close the prompt, stay in plan mode, keep chatting.
    });

    pi.registerCommand("plan", {
        description: "Toggle plan mode (read-only exploration + write_plan/edit_plan)",
        handler: async (_, ctx) => togglePlanMode(ctx),
    });

    pi.registerTool({
        name: "write_plan",
        label: "Write Plan",
        description: "Write a plan markdown file to .pi/plans/<filename>.md. Creates the .pi/plans directory if needed. Overwrites the file if it already exists.",
        promptSnippet: "Write or replace a planning markdown file under .pi/plans",
        promptGuidelines: [
            "Use write_plan to record a plan under .pi/plans/<name>.md while in plan mode.",
            "Pass a concise filename and the full markdown plan content.",
        ],
        parameters: WritePlanParams,

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            if (!planModeActive) {
                return {
                    content: [{ type: "text", text: "Error: plan mode is not active. Run /plan first." }],
                    details: { filename: params.filename, fullPath: "" },
                };
            }

            const filename = normalizePlanFilename(params.filename);
            const dir = plansDir(ctx.cwd);
            const fullPath = join(dir, filename);

            // Delegate to pi's built-in write tool instead of hand-rolling the
            // fs calls: it creates parent directories, serializes through the
            // file mutation queue, and observes abort signals.
            const writeToolDef = createWriteToolDefinition(ctx.cwd);
            await writeToolDef.execute(
                "write_plan",
                { path: fullPath, content: params.content },
                _signal,
                undefined,
                ctx,
            );

            return {
                content: [{ type: "text", text: params.content }],
                details: { filename, fullPath },
            };
        },
    });

    pi.registerTool({
        name: "edit_plan",
        label: "Edit Plan",
        description: "Edit an existing plan markdown file under .pi/plans by replacing old_text with new_text. Errors if old_text is not found, or if it matches more than once (ambiguous — refuses to edit).",
        promptSnippet: "Edit an existing plan markdown file under .pi/plans",
        promptGuidelines: [
            "Use edit_plan (not edit/write) to update a plan file while plan mode is active.",
            "old_text must match exactly and appear exactly once in the file; if it matches multiple times, edit_plan refuses to edit, so make old_text more specific.",
        ],
        parameters: EditPlanParams,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            if (!planModeActive) {
                return {
                    content: [{ type: "text", text: "Error: plan mode is not active. Run /plan first." }],
                    details: { filename: params.filename, fullPath: "" },
                };
            }

            const filename = normalizePlanFilename(params.filename);
            const fullPath = join(plansDir(ctx.cwd), filename);

            // Delegate to pi's built-in edit tool instead of hand-rolling text
            // matching: it errors on missing or ambiguous (non-unique) old_text,
            // preserves BOM and line endings, handles empty old_text, and
            // serializes the write through the file mutation queue.
            const editToolDef = createEditToolDefinition(ctx.cwd);
            await editToolDef.execute(
                "edit_plan",
                { path: fullPath, edits: [{ oldText: params.old_text, newText: params.new_text }] },
                _signal,
                undefined,
                ctx,
            );

            const updated = await readFile(fullPath, "utf8");
            return {
                content: [{ type: "text", text: updated }],
                details: { filename, fullPath },
            };
        },
    });
}
