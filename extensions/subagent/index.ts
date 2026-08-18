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
import { runAgent, runAgentInBackground } from "./run";
import { SubagentParams } from "./schema";
import type { BackgroundTaskInfo, SingleResult, SubagentDetails } from "./types";
import { getFinalOutput, getResultOutput, isFailedResult } from "./utils";

const MAX_TASK_STATUS_LENGTH = 75;

function truncateTaskForStatus(task: string, maxLength: number): string {
    task = task.replace(/\r\n|\n/g, " ");
    if (task.length <= maxLength) return task;
    return task.slice(0, maxLength - 3) + "...";
}

export default function subagentExtension(pi: ExtensionAPI) {
    const backgroundAgents = new Map<string, { agent: string; task: string }>();

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
        const list = agents.map(a => `- ${a.name}: ${a.description}`).join("\n");
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
        promptSnippet: "Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it",
        description: `
## When not to use

If the target is already known, use the direct tool: Read for a known path, grep via the Bash tool for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.

## Usage notes

- Always include a short description summarizing what the agent will do
- When the agent is done, its final report is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting the work as done.
- Foreground vs background: Pass runInBackground: false to run an agent in the foreground when you need its results before you can proceed — e.g., research agents whose findings inform your next steps. Otherwise let it run in the background so you can keep working in parallel.
- When an agent runs in the background, you will be automatically notified when it completes — do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.
- Don't race: after launching a background agent, you know nothing about its results. Never fabricate or predict them in any format — not as prose, summary, or structured output. The completion notification arrives in a later turn; it is never
something you write yourself. If the user asks before it lands, say the agent is still running — give status, not a guess.
- A new Agent call starts a fresh agent with no memory of prior runs, so the prompt must be self-contained.
- Each agent type's model, reasoning effort, and tool access are set in its definition (.claude/agents/*.md frontmatter, or the SDK agents option); the model parameter here overrides the definition for this one call. Only pass it if the user explicitly specifies which model to use.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since a fresh agent is not aware of the user's intent
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first.
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple Agent tool use content blocks. For example, if you need to launch both a build-validator agent and a test-runner agent in parallel,
send a single message with both tool calls.

## Writing the prompt

Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding**. Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file
paths, line numbers, what specifically to change.
        `.trim(),
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
                const dir = discovery.projectClaudeAgentsDir ?? "(unknown)";
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
                const bg = await runAgentInBackground(ctx.cwd, agents, params.agent, params.task, undefined, params.model);
                if ("error" in bg) {
                    return {
                        content: [{ type: "text", text: bg.error }],
                        details: makeDetails("background")([], []),
                        isError: true,
                    };
                }

                const theme = ctx.ui.theme;
                backgroundAgents.set(bg.backgroundId, { agent: bg.agent, task: bg.task });
                updateBackgroundWidget(ctx.ui);

                bg.done.then(async ({ exitCode }) => {
                    const icon = exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
                    setTimeout(() => backgroundAgents.delete(bg.backgroundId), 10000);
                    updateBackgroundWidget(ctx.ui);

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
                            content: `${icon} ${bg.agent} ${status}:\n${outputText}`,
                            display: true,
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
                            display: true,
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

            const result = await runAgent(
                ctx.cwd,
                agents,
                params.agent,
                params.task,
                params.model,
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
