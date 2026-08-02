/**
 * Subagent Tool - Delegate tasks to specialized agents.
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 */

import type { AgentToolResult, ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import fs from "fs";

import { discoverAgents } from "./agents";
import { renderCall, renderResult } from "./renderer";
import { runAgentInBackground, runSingleAgent } from "./run";
import { SubagentParams } from "./schema";
import type { BackgroundTaskInfo, SingleResult, SubagentDetails } from "./types";
import { getFinalOutput, getResultOutput, isFailedResult } from "./utils";

const MAX_TASK_STATUS_LENGTH = 100;

function truncateTaskForStatus(task: string, maxLength: number): string {
    if (task.length <= maxLength) return task;
    return task.slice(0, maxLength - 3) + "...";
}

export default function subagentExtension(pi: ExtensionAPI) {
    const backgroundAgents = new Map<string, { agent: string; task: string; statusKey: string }>();

    function updateBackgroundWidget(ui: ExtensionUIContext) {
        const WIDGET_KEY = "my-subagent-widget";
        if (backgroundAgents.size === 0) {
            ui.setWidget(WIDGET_KEY, undefined);
            return;
        }
        const theme = ui.theme;
        const lines = Array.from(backgroundAgents.values()).map(({ agent, task }) => {
            const truncated = truncateTaskForStatus(task, MAX_TASK_STATUS_LENGTH);
            return theme.fg("accent", "●") + " " + theme.fg("dim", agent) + " " + truncated;
        });
        ui.setWidget(WIDGET_KEY, lines, { placement: "belowEditor" });
    }

    pi.on("resources_discover", (_event, ctx) => {
        const discovery = discoverAgents(ctx.cwd);
        const agents = discovery.agents;
        if (agents.length === 0) return;
        const list = agents.map(a => `${a.name}: ${a.description}`).join("\n");
        pi.sendMessage({
            customType: "subagent-available-agents",
            content: `Available subagents:\n${list}`,
            display: false,
        }, {
            triggerTurn: false,
        });
    });

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
                const available = agents.map(a => a.name).join(", ") || "none";
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
                backgroundAgents.set(bg.backgroundId, { agent: bg.agent, task: bg.task, statusKey });
                updateBackgroundWidget(ctx.ui);
                bg.done.then(async ({ exitCode }) => {
                    const icon = exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
                    backgroundAgents.delete(bg.backgroundId);
                    updateBackgroundWidget(ctx.ui);
                    setTimeout(() => ctx.ui.setStatus(statusKey, undefined), 10_000);

                    // Read output and notify user (small delay to ensure file is flushed)
                    await new Promise(resolve => setTimeout(resolve, 100));
                    try {
                        const output = await fs.promises.readFile(bg.outputPath, "utf-8");
                        const lines = output.split("\n").filter(l => l.trim());
                        let resultText = "";
                        let errorText = "";
                        for (const line of lines) {
                            try {
                                const event = JSON.parse(line);
                                if (event.type === "agent_end" && Array.isArray(event.messages)) {
                                    for (const msg of event.messages) {
                                        // Get text from assistant messages
                                        if (msg.role === "assistant" && Array.isArray(msg.content)) {
                                            for (const part of msg.content) {
                                                if (part.type === "text" && part.text) {
                                                    resultText = part.text;
                                                }
                                            }
                                        }
                                        // Get error from toolResult messages - check both msg.isError and content isError
                                        const isError = msg.isError === true || (Array.isArray(msg.content) && msg.content.some((p: { isError: boolean }) => p.isError === true));
                                        if (msg.role === "toolResult" && Array.isArray(msg.content) && isError) {
                                            for (const part of msg.content) {
                                                if (part.type === "text" && part.text) {
                                                    errorText = part.text;
                                                }
                                            }
                                        }
                                    }
                                    // Check stopReason of last assistant message
                                    const lastMsg = event.messages[event.messages.length - 1];
                                    if (lastMsg?.role === "assistant" && lastMsg.stopReason && lastMsg.stopReason !== "endTurn") {
                                        errorText = errorText || `Stop reason: ${lastMsg.stopReason}`;
                                    }
                                }
                            }
                            catch { /* ignore parse errors */ }
                        }
                        const status = exitCode === 0 ? "completed" : `failed (exit ${exitCode})`;
                        let outputText = resultText;
                        if (!outputText && errorText) outputText = errorText;
                        if (!outputText) outputText = "(no output)";
                        pi.sendMessage({
                            customType: "subagent-bg-result",
                            content: `${icon} ${bg.agent} ${status}: ${outputText}`,
                            display: false,
                        }, {
                            triggerTurn: true,
                            deliverAs: "steer",
                        });
                    }
                    catch {
                        const status = exitCode === 0 ? "completed" : `failed (exit ${exitCode})`;
                        pi.sendMessage({
                            customType: "subagent-bg-result",
                            content: `${icon} ${bg.agent} ${status}`,
                            display: false,
                        }, {
                            triggerTurn: true,
                            deliverAs: "steer",
                        });
                    }
                });
                // Strip the 'done' Promise before including in details to avoid cloning errors
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const { done: _, ...bgInfo } = bg;
                return {
                    content: [
                        {
                            type: "text",
                            text: `Started agent ${bg.agent} in background (${bg.backgroundId}).\nOutput: ${bg.outputPath}\nErrors: ${bg.errorPath}`,
                        },
                    ],
                    details: makeDetails("background")([], [bgInfo]),
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
