/**
 * Subagent Tool - Delegate tasks to specialized agents.
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { discoverAgents } from "./agents";
import { renderCall, renderResult } from "./renderer";
import { runAgentInBackground, runSingleAgent } from "./run";
import { SubagentParams } from "./schema";
import type { BackgroundTaskInfo, SingleResult, SubagentDetails } from "./types";
import { getFinalOutput, getResultOutput, isFailedResult } from "./utils";

export default function subagentExtension(pi: ExtensionAPI) {
    pi.registerTool({
        name: "subagent",
        label: "Subagent",
        description: [
            "Delegate tasks to specialized subagents with isolated context.",
            "Set runInBackground: true to start the agent without blocking the parent.",
        ].join(" "),
        parameters: SubagentParams,

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            // Scope and trust enforcement are controlled by the tool, not the
            // assistant: both user-level and project-local agents are
            // discovered, and any project-local agent is gated behind the
            // project trust check without offering a bypass.
            const discovery = discoverAgents(ctx.cwd);
            const agents = discovery.agents;

            const makeDetails = (mode: "single" | "background") =>
                (results: SingleResult[], backgroundTasks: BackgroundTaskInfo[] = []): SubagentDetails => ({
                    mode,
                    projectClaudeAgentsDir: discovery.projectClaudeAgentsDir,
                    projectOpencodeAgentsDir: discovery.projectOpencodeAgentsDir,
                    results,
                    backgroundTasks,
                });

            if (!params.agent || !params.task) {
                const available = agents.map(a => `${a.name} (${a.source})`).join(", ") || "none";
                return {
                    content: [
                        {
                            type: "text",
                            text: `Invalid parameters. Provide agent and task.\nAvailable agents: ${available}`,
                        },
                    ],
                    details: makeDetails("single")([], []),
                };
            }

            const agent = agents.find(a => a.name === params.agent);
            if (agent?.source === "project" && !ctx.isProjectTrusted() && ctx.hasUI) {
                const dirs = [
                    discovery.projectClaudeAgentsDir,
                    discovery.projectOpencodeAgentsDir,
                ].filter(Boolean);
                const dir = dirs.length > 0 ? dirs.join(", ") : "(unknown)";
                const ok = await ctx.ui.confirm(
                    "Run project-local agent?",
                    `Agent: ${agent.name}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
                );
                if (!ok) {
                    return {
                        content: [{ type: "text", text: "Canceled: project-local agent not approved." }],
                        details: makeDetails("single")([], []),
                    };
                }
            }

            if (params.runInBackground) {
                const bg = await runAgentInBackground(ctx.cwd, agents, params.agent, params.task, undefined);
                if ("error" in bg) {
                    return {
                        content: [{ type: "text", text: bg.error }],
                        details: makeDetails("background")([], []),
                        isError: true,
                    };
                }
                const statusKey = `subagent-bg-${bg.backgroundId}`;
                const theme = ctx.ui.theme;
                ctx.ui.setStatus(statusKey, theme.fg("accent", "●") + " " + theme.fg("dim", `${bg.agent} ${bg.task.slice(0, 40)}`));
                bg.done.then(({ exitCode }) => {
                    const icon = exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
                    const label = exitCode === 0 ? "done" : "failed";
                    ctx.ui.setStatus(statusKey, icon + " " + theme.fg("dim", `${bg.agent} ${label}`));
                    setTimeout(() => ctx.ui.setStatus(statusKey, undefined), 10_000);
                });
                return {
                    content: [
                        {
                            type: "text",
                            text: `Started agent ${bg.agent} in background (${bg.backgroundId}).\nOutput: ${bg.outputPath}\nErrors: ${bg.errorPath}`,
                        },
                    ],
                    details: makeDetails("background")([], [bg]),
                };
            }

            const result = await runSingleAgent(
                ctx.cwd,
                agents,
                params.agent,
                params.task,
                undefined,
                undefined,
                signal,
                onUpdate,
                makeDetails("single"),
            );
            if (isFailedResult(result)) {
                const errorMsg = getResultOutput(result);
                return {
                    content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
                    details: makeDetails("single")([result]),
                    isError: true,
                };
            }
            return {
                content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
                details: makeDetails("single")([result]),
            };
        },

        renderCall: (args, theme) => renderCall(args, theme),
        renderResult: (result, options, theme) => renderResult(result as AgentToolResult<SubagentDetails>, options, theme),
    });
}
