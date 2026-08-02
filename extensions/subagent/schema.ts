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
});
