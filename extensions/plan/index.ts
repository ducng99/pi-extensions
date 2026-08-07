/**
 * Plan Extension
 *
 * `/plan` toggles a read-only "plan mode". In plan mode the active tool set is
 * restricted to read-only exploration tools plus the `write_plan` / `edit_plan`
 * tools, and tool-permissions is told (via the shared `pi.events` bus) to gate
 * every intercepted tool against the plan-mode permission set.
 *
 * After a plan is written or edited, the user is prompted to implement it,
 * clear and restart, or keep chatting.
 *
 * Plan mode is in-memory only. Every session starts with plan mode off.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

import type { ParsedPermissions } from "../tool-permissions/src/permission-parsing";
import { renderCall, renderResult } from "./renderer";
import { EditPlanParams, WritePlanParams } from "./schema";

// ============================================================================
// Plan-mode tagged tools
// ============================================================================

/** Tools available while plan mode is active. */
const PLAN_TOOL_NAMES = new Set(["read", "bash", "grep", "find", "ls", "ask_user_questions", "write_plan", "edit_plan"]);

/**
 * Plan-mode permission set emitted so tool-permissions can gate plan-mode tool
 * calls. It is deny-focused: mutating tools and destructive bash commands are
 * blocked outright, while everything else flows through the user's own settings
 * (bash defaults to "ask" when not explicitly allowed).
 */
export const PLAN_MODE_PERMISSIONS: ParsedPermissions = {
    allow: [],
    ask: [],
    deny: [
        { category: "edit", pattern: "*" },
        { category: "write", pattern: "*" },
        // Filesystem mutators
        { category: "bash", pattern: "rm *" },
        { category: "bash", pattern: "mv *" },
        { category: "bash", pattern: "cp *" },
        { category: "bash", pattern: "touch *" },
        { category: "bash", pattern: "mkdir *" },
        { category: "bash", pattern: "rmdir *" },
        { category: "bash", pattern: "chmod *" },
        { category: "bash", pattern: "chown *" },
        { category: "bash", pattern: "ln *" },
        { category: "bash", pattern: "truncate *" },
        { category: "bash", pattern: "shred *" },
        { category: "bash", pattern: "dd *" },
        { category: "bash", pattern: "tee *" },
        { category: "bash", pattern: "install *" },
        { category: "bash", pattern: "sed -i *" },
        // Version control
        { category: "bash", pattern: "git add *" },
        { category: "bash", pattern: "git commit *" },
        { category: "bash", pattern: "git push *" },
        { category: "bash", pattern: "git pull *" },
        { category: "bash", pattern: "git reset *" },
        { category: "bash", pattern: "git checkout *" },
        { category: "bash", pattern: "git clean *" },
        { category: "bash", pattern: "git rm *" },
        { category: "bash", pattern: "git stash *" },
        { category: "bash", pattern: "git merge *" },
        { category: "bash", pattern: "git rebase *" },
        // Package managers / build tools
        { category: "bash", pattern: "npm install *" },
        { category: "bash", pattern: "npm run *" },
        { category: "bash", pattern: "bun install *" },
        { category: "bash", pattern: "bun run *" },
        { category: "bash", pattern: "yarn *" },
        { category: "bash", pattern: "pnpm *" },
        { category: "bash", pattern: "make *" },
        { category: "bash", pattern: "pip install *" },
        { category: "bash", pattern: "apt *" },
        { category: "bash", pattern: "apt-get *" },
        { category: "bash", pattern: "brew *" },
    ],
    additionalDirectories: [],
};

// ============================================================================
// Helpers
// ============================================================================

function normalizePlanFilename(filename: string): string {
    const trimmed = filename.trim();
    return trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
}

function plansDir(cwd: string): string {
    return join(cwd, CONFIG_DIR_NAME, "plans");
}

async function readPlanOrThrow(fullPath: string, filename: string): Promise<string> {
    try {
        return await readFile(fullPath, "utf8");
    }
    catch {
        throw new Error(`Plan file not found: ${filename}`);
    }
}

// ============================================================================
// Extension
// ============================================================================

export default function planExtension(pi: ExtensionAPI) {
    // In-memory state. Always starts false for every session.
    let planModeActive = false;
    let toolsBeforePlanMode: string[] = [];

    function emitDeactivated(): void {
        pi.events.emit("plan_mode:deactivated", {});
    }

    function deactivatePlanMode(ctx: ExtensionContext): void {
        if (!planModeActive) return;
        planModeActive = false;
        pi.setActiveTools(toolsBeforePlanMode);
        toolsBeforePlanMode = [];
        emitDeactivated();
        ctx.ui.notify("Plan mode disabled. Full access restored.", "info");
    }

    function togglePlanMode(ctx: ExtensionCommandContext): void {
        if (planModeActive) {
            deactivatePlanMode(ctx);
            return;
        }

        toolsBeforePlanMode = pi.getActiveTools();
        pi.setActiveTools([...PLAN_TOOL_NAMES]);
        planModeActive = true;
        pi.events.emit("plan_mode:activated", PLAN_MODE_PERMISSIONS);
        ctx.ui.notify("Plan mode enabled. Only read-only tools and plan writing are allowed.", "info");
    }

    // No state persistence: every session starts with plan mode off.
    pi.on("session_start", (_event, ctx) => {
        if (planModeActive) deactivatePlanMode(ctx);
        planModeActive = false;
        toolsBeforePlanMode = [];
    });

    // After a plan tool finishes, offer next steps.
    pi.on("tool_execution_end", async (event, ctx) => {
        if (!planModeActive || !PLAN_TOOL_NAMES.has(event.toolName) || !ctx.hasUI) return;

        const choice = await ctx.ui.select("Plan ready — what next?", [
            "Implement now — exit plan mode and continue working",
            "Clear & implement — start fresh (not yet implemented)",
            "Chat more — stay in plan mode and keep chatting",
        ]);

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
        handler: async (_args, ctx) => togglePlanMode(ctx),
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

            await mkdir(dir, { recursive: true });
            await writeFile(fullPath, params.content, "utf8");

            return {
                content: [{ type: "text", text: params.content }],
                details: { filename, fullPath },
            };
        },
        renderCall: renderCall,
        renderResult: renderResult,
    });

    pi.registerTool({
        name: "edit_plan",
        label: "Edit Plan",
        description: "Edit an existing plan markdown file under .pi/plans by replacing the first occurrence of old_text with new_text. Errors if old_text is not found.",
        promptSnippet: "Edit an existing plan markdown file under .pi/plans",
        promptGuidelines: [
            "Use edit_plan (not edit/write) to update a plan file while plan mode is active.",
            "old_text must match exactly; replace the first occurrence only.",
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

            return withFileMutationQueue(fullPath, async () => {
                const current = await readPlanOrThrow(fullPath, filename);
                const idx = current.indexOf(params.old_text);
                if (idx === -1) {
                    throw new Error(`old_text not found in ${filename}`);
                }
                const updated = current.slice(0, idx) + params.new_text + current.slice(idx + params.old_text.length);
                await writeFile(fullPath, updated, "utf8");

                return {
                    content: [{ type: "text", text: updated }],
                    details: { filename, fullPath },
                };
            });
        },
        renderCall: renderCall,
        renderResult: renderResult,
    });
}
