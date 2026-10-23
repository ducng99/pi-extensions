/**
 * TypeBox schema for the websearch tool parameters.
 */

import { Type } from "typebox";

export const WebSearchParams = Type.Object({
    query: Type.String({ description: "The search query string" }),
    max_results: Type.Optional(
        Type.Integer({
            description: "Maximum results to return (default 5, max 10).",
            default: 5,
            minimum: 1,
            maximum: 10,
        }),
    ),
});
