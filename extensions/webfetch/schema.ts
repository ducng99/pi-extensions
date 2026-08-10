/**
 * TypeBox schema for the webfetch tool parameters.
 */

import { Type } from "typebox";

export const WebFetchParams = Type.Object({
    url: Type.String({ description: "The URL to fetch" }),
    timeoutMs: Type.Optional(
        Type.Integer({
            description: "Optional timeout in milliseconds (default 30000).",
            minimum: 1000,
        }),
    ),
    prompt: Type.Optional(
        Type.String({
            description: "Optional prompt to extract specific information from the fetched content. If not provided, the raw content is returned without sanitization.",
        }),
    ),
});
