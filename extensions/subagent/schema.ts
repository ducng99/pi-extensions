/**
 * TypeBox schemas for the subagent tool.
 */

import { Type } from "typebox";

export const SubagentParams = Type.Object({
    agent: Type.String({ description: "Name of the agent to invoke" }),
    task: Type.String({ description: "Task to delegate to the agent" }),
    runInBackground: Type.Optional(
        Type.Boolean({
            description: "Start the subagent and return immediately without waiting for results.",
            default: false,
        }),
    ),
    model: Type.Optional(
        Type.String({
            description: "Model to use for this agent, in the format \"<provider>/<model>\". Only set this if the user explicitly specifies a model to use; otherwise omit it and let the agent's configured model be used.",
        }),
    ),
});
