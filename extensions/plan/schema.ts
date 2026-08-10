/**
 * TypeBox schemas for the plan tools (write_plan / edit_plan).
 */

import { Type } from "typebox";

export const WritePlanParams = Type.Object({
    filename: Type.String({
        description: "Name of the plan file (a `.md` extension is appended automatically)",
        minLength: 1,
    }),
    content: Type.String({
        description: "Full markdown content of the plan",
    }),
});

export const EditPlanParams = Type.Object({
    filename: Type.String({
        description: "Name of the plan file (with or without the `.md` extension)",
        minLength: 1,
    }),
    old_text: Type.String({
        description: "Exact text to locate; must match exactly once or the edit is refused",
    }),
    new_text: Type.String({
        description: "Replacement text for the located `old_text`",
    }),
});

export interface PlanDetails {
    filename: string;
    fullPath: string;
}
