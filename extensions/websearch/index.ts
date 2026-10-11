/**
 * Websearch Tool
 *
 * Performs web searches via the `aimachine` provider's `/v1/search` endpoint.
 */

import { type ExtensionAPI, truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { WebContentCache } from "../shared/web-content-cache/index";
import { WebSearchParams } from "./schema";
import { webSearch, type WebSearchResponse } from "./search";

function formatResults(data: WebSearchResponse): string {
    const lines = data.results.map((r, i) => {
        const title = r.title || "(no title)";

        let content = r.snippet;
        const truncatedContent = truncateHead(r.snippet, { maxLines: 40, maxBytes: 4096 });
        if (truncatedContent.truncated) {
            content = truncatedContent.content + " ...(truncated, fetch the URL using webfetch to get full content)";
        }

        return `
## Result ${i + 1}

Title: ${title}
URL: ${r.url}
Content:
\`\`\`
${content}
\`\`\`
`.trim();
    });

    return lines.length > 0 ? lines.join("\n\n---\n\n") : "No results found.";
}

export default function websearchTool(pi: ExtensionAPI) {
    const now = new Date();
    const CURRENT_MONTH_YEAR = now.getFullYear() + "-" + (now.getMonth() + 1).toString().padStart(2, "0");
    const cache = new WebContentCache();

    pi.registerTool({
        name: "websearch",
        label: "WebSearch",
        promptSnippet: "Search the web and returns search result information formatted as search result blocks, including links",
        description: `Search the web to get information beyound knowledge cutoff. The current month is ${CURRENT_MONTH_YEAR}. You MUST use this year when searching for recent information, documentation, or current events`,
        promptGuidelines: [
            "Use websearch for current information beyond knowledge cutoff",
        ],
        parameters: WebSearchParams,

        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const maxResults = params.max_results ?? 5;

            try {
                const data = await webSearch(params.query, maxResults, ctx.modelRegistry, signal);

                // Cache the snippet so a later webfetch of the same URL can
                // skip the network fetch and HTML→markdown conversion.
                for (const r of data.results) {
                    if (r.url && r.snippet) {
                        await cache.set(r.url, r.snippet);
                    }
                }

                return {
                    content: [{ type: "text" as const, text: formatResults(data) }],
                    details: { query: params.query, results: data.results },
                };
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `Web search failed: ${message}` }],
                    details: { query: params.query, results: [] },
                    isError: true,
                };
            }
        },

        renderCall(args, theme) {
            const parts = [theme.fg("toolTitle", theme.bold("websearch "))];
            parts.push(theme.fg("muted", args.query));
            return new Text(parts.join(""), 0, 0);
        },
    });
}
