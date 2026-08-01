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
import type { AgentScope, BackgroundTaskInfo, SingleResult, SubagentDetails } from "./types";
import { getFinalOutput, getResultOutput, isFailedResult } from "./utils";

export default function subagentExtension(pi: ExtensionAPI) {
    pi.registerTool({
        name: "subagent",
        label: "Subagent",
        description: [
            "Delegate tasks to specialized subagents with isolated context.",
            "Default agent scope is \"user\" (from ~/.claude/agents or ~/.config/opencode/agents).",
            "To enable project-local agents, set agentScope: \"both\" (or \"project\").",
            "Set runInBackground: true to start the agent without blocking the parent.",
        ].join(" "),
        parameters: SubagentParams,

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const agentScope: AgentScope = params.agentScope ?? "user";
            const discovery = discoverAgents(ctx.cwd, agentScope);
            const agents = discovery.agents;
            const confirmProjectAgents = params.confirmProjectAgents ?? true;

            const makeDetails
                = (mode: "single" | "background") =>
                    (results: SingleResult[], backgroundTasks: BackgroundTaskInfo[] = []): SubagentDetails => ({
                        mode,
                        agentScope,
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

            if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
                const agent = agents.find(a => a.name === params.agent);
                if (agent?.source === "project" && !ctx.isProjectTrusted()) {
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
            }

            if (params.runInBackground) {
                const bg = await runAgentInBackground(ctx.cwd, agents, params.agent, params.task, params.cwd);
                if ("error" in bg) {
                    return {
                        content: [{ type: "text", text: bg.error }],
                        details: makeDetails("background")([], []),
                        isError: true,
                    };
                }
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
                params.cwd,
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
