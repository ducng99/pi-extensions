/**
 * Webfetch Tool
 *
 * Fetches a URL via the Firecrawl `/v2/scrape` endpoint.
 * Content sanitization and HTML→markdown conversion are handled by Firecrawl.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { WebContentCache } from "../../shared/web-content-cache/index";
import { FirecrawlError, scrapeUrl } from "./firecrawl";
import { WebFetchParams } from "./schema";

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** Structured details returned for every webfetch result. */
interface WebFetchDetails {
    ok: boolean;
    url: string;
    cached: boolean;
    status?: number;
    title?: string;
}

export default function webfetchTool(pi: ExtensionAPI) {
    const cache = new WebContentCache();
    pi.registerTool<typeof WebFetchParams, WebFetchDetails>({
        name: "webfetch",
        label: "WebFetch",
        promptSnippet: "Fetch a URL and return a summarized markdown response if the page is HTML, otherwise raw content",
        description: `
IMPORTANT: webfetch WILL FAIL for authenticated URLs. Before using this tool, check if the URL points to an authenticated service (e.g. Google Docs, Confluence, Jira, GitHub). If so, look for a specialized MCP tool that provides
authenticated access.

- Fetches content from a specified URL and returns it as markdown
- Takes a URL and an optional prompt as input
- Converts HTML to markdown and sanitizes the content server-side via Firecrawl
- If a prompt is provided, it is answered as a natural-language question about the page and the answer is returned
- Otherwise the raw page markdown is returned
- Use this tool when you need to retrieve and analyze web content

Usage notes:
- The URL must be a fully-formed valid URL
- The prompt should describe what information you want to extract from the page
- This tool is read-only and does not modify any files
- Results may be summarized if the content is very large
- Includes a self-cleaning 15-minute cache for faster responses when repeatedly accessing the same URL
- For GitHub URLs, prefer using the gh CLI via Bash instead (e.g., gh pr view, gh issue view, gh api).
        `.trim(),
        promptGuidelines: [
            "Use webfetch when you need the summarized content of a specific URL.",
        ],
        parameters: WebFetchParams,

        async execute(_toolCallId, params, signal) {
            const timeoutMs = params.timeoutMs && params.timeoutMs > DEFAULT_FETCH_TIMEOUT_MS ? params.timeoutMs : DEFAULT_FETCH_TIMEOUT_MS;

            let text: string;
            let title: string | undefined;
            let finalUrl = params.url;
            let status: number;
            let fromCache: boolean;

            // A prompt needs a fresh scrape with the question format, so the
            // cache is only consulted for plain fetches.
            const cachedMarkdown = params.prompt === undefined ? await cache.get(params.url) : undefined;
            if (cachedMarkdown !== undefined) {
                text = cachedMarkdown;
                status = 200;
                fromCache = true;
            }
            else {
                const apiUrl = process.env.TOM_FIRECRAWL_API_URL ?? "https://api.firecrawl.dev";
                const apiKey = process.env.TOM_FIRECRAWL_API_KEY;
                if (!apiKey) {
                    return {
                        content: [{ type: "text" as const, text: "webfetch requires the TOM_FIRECRAWL_API_KEY environment variable." }],
                        details: { url: params.url, ok: false, cached: false },
                        isError: true,
                    };
                }

                const controller = new AbortController();
                const outerSignal = signal ?? undefined;
                const abortFromEither = () => controller.abort();
                if (outerSignal) {
                    if (outerSignal.aborted) controller.abort();
                    else outerSignal.addEventListener("abort", abortFromEither, { once: true });
                }
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

                try {
                    const result = await scrapeUrl(apiUrl, apiKey, params.url, params.prompt, controller.signal);
                    text = result.answer ?? result.markdown;
                    title = result.title;
                    finalUrl = result.url ?? params.url;
                    status = result.status;
                    fromCache = false;
                    // Cache the markdown so later plain fetches of the same URL skip the network.
                    await cache.set(params.url, result.markdown);
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    const aborted = controller.signal.aborted;
                    const errStatus = err instanceof FirecrawlError ? err.status : undefined;
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: aborted
                                    ? `webfetch aborted (timeout after ${timeoutMs}ms or canceled): ${params.url}`
                                    : `Failed to fetch ${params.url}: ${message}`,
                            },
                        ],
                        details: { url: params.url, status: errStatus, ok: false, cached: false },
                        isError: true,
                    };
                }
                finally {
                    clearTimeout(timeoutId);
                    if (outerSignal) outerSignal.removeEventListener("abort", abortFromEither);
                }
            }

            return {
                content: [{ type: "text" as const, text }],
                details: {
                    url: finalUrl,
                    title,
                    status,
                    ok: true,
                    cached: fromCache,
                },
            };
        },

        renderCall(args, theme) {
            const parts = [theme.fg("toolTitle", theme.bold("webfetch "))];
            parts.push(theme.fg("muted", args.url));
            if (args.prompt) {
                parts.push(" ");
                parts.push(theme.fg("dim", `"${args.prompt}"`));
            }
            return new Text(parts.join(""), 0, 0);
        },
    });
}
