/**
 * Websearch Tool
 *
 * Performs web searches via Ollama's web search API.
 */

import { type ExtensionAPI, truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { WebContentCache } from "../shared/web-content-cache/index";
import type { WebSearchResponse } from "./ollama";
import { ollamaWebSearch } from "./ollama";
import { WebSearchParams } from "./schema";

function formatResults(data: WebSearchResponse): string {
    const lines = data.results.map((r, i) => {
        const title = r.title || "(no title)";

        let content = r.content;
        const truncatedContent = truncateHead(r.content, { maxLines: 20, maxBytes: 1024 });
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
        promptSnippet: "Search the web and returns search result information formatted as search result blocks, including links as markdown hyperlinks",
        description: `
CRITICAL REQUIREMENT - You MUST follow this:
  - After answering the user's question, you MUST include a "Sources:" section at the end of your response
  - In the Sources section, list all relevant URLs from the search results as markdown hyperlinks: [Title](URL)
  - This is MANDATORY - never skip including sources in your response
  - Example format:

    [Your answer here]

    Sources:
    - [Source Title 1](https://example.com/1)
    - [Source Title 2](https://example.com/2)

IMPORTANT - Use the correct year in search queries:
  - The current month is ${CURRENT_MONTH_YEAR}. You MUST use this year when searching for recent information, documentation, or current events.
  - Example: If the user asks for "latest React docs", search for "React documentation" with the current year, NOT last year
            `.trim(),
        promptGuidelines: [
            "Use websearch to discover relevant URLs before calling webfetch.",
            "Use websearch for accessing information beyond your knowledge cutoff",
        ],
        parameters: WebSearchParams,

        async execute(_toolCallId, params, signal) {
            const maxResults = params.max_results ?? 5;

            try {
                const data = await ollamaWebSearch(params.query, maxResults, signal);

                // Cache the full page content so a later webfetch of the same
                // URL can skip the network fetch and HTML→markdown conversion.
                for (const r of data.results) {
                    if (r.url && r.content) {
                        await cache.set(r.url, r.content);
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
