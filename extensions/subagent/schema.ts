/**
 * TypeBox schemas for the subagent tool.
 */

import { Type } from "typebox";

const AgentScopeSchema = Type.Union(
    [Type.Literal("user"), Type.Literal("project"), Type.Literal("both")],
    { default: "user" },
);

export const SubagentParams = Type.Object({
    agent: Type.String({ description: "Name of the agent to invoke" }),
    task: Type.String({ description: "Task to delegate to the agent" }),
    agentScope: Type.Optional(AgentScopeSchema),
    confirmProjectAgents: Type.Optional(
        Type.Boolean({
            description: "Prompt before running project-local agents. Default: true.",
            default: true,
        }),
    ),
    runInBackground: Type.Optional(
        Type.Boolean({
            description: "Start the subagent and return immediately without waiting for results.",
            default: false,
        }),
    ),
    cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});
