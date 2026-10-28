/**
 * Webfetch Tool
 *
 * Fetches a URL via the Tom API (`$TOM_API_URL/v1/web/fetch`),
 * and sanitizes the content via an isolated pi session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { WebContentCache } from "../../shared/web-content-cache/index";
import { sanitizeWithPiSession } from "./sanitize";
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

/** Response shape from the Tom API `/v1/web/fetch` endpoint. */
interface FetchResponse {
    content?: string | { format?: string; text?: string };
    title?: string | null;
    url?: string;
}

/**
 * Extract the markdown text from the API's `content` field, which is an
 * object (`{ format, text, length }`) but may be a plain string for other
 * providers/formats.
 */
function extractContentText(content: FetchResponse["content"]): string {
    if (typeof content === "string") return content;
    return content?.text ?? "";
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

- Fetches content from a specified URL and processes it using an AI model
- Takes a URL and a prompt as input
- Fetches the URL content, converts HTML to markdown
- Processes the content with the prompt using a small, fast model
- Returns the model's response about the content
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

        async execute(_toolCallId, params, signal, _, ctx) {
            const timeoutMs = params.timeoutMs && params.timeoutMs > DEFAULT_FETCH_TIMEOUT_MS ? params.timeoutMs : DEFAULT_FETCH_TIMEOUT_MS;

            // Pass 1: obtain the markdown. A cache hit (e.g. from websearch)
            // gives us the already-converted markdown directly; otherwise we
            // fetch the URL and convert HTML→markdown.
            let markdown: string;
            let title: string | undefined;
            let finalUrl = params.url;
            let status: number;
            let fromCache: boolean;

            const cachedMarkdown = await cache.get(params.url);
            if (cachedMarkdown !== undefined) {
                markdown = cachedMarkdown;
                status = 200;
                fromCache = true;
            }
            else {
                const apiUrl = process.env.TOM_API_URL;
                const apiKey = process.env.TOM_API_KEY;
                if (!apiUrl || !apiKey) {
                    return {
                        content: [{ type: "text" as const, text: "webfetch requires TOM_API_URL and TOM_API_KEY environment variables." }],
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
                    const response = await fetch(`${apiUrl.replace(/\/+$/, "")}/v1/web/fetch`, {
                        method: "POST",
                        signal: controller.signal,
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": `Bearer ${apiKey}`,
                        },
                        body: JSON.stringify({
                            model: "fetch-combo",
                            url: params.url,
                            format: "markdown",
                            max_characters: 0,
                        }),
                    });

                    if (!response.ok) {
                        const body = await response.text();
                        const bodyText = body.length > 0 ? `\n${body}` : "";
                        return {
                            content: [{ type: "text" as const, text: `Failed to fetch ${params.url} (${response.status} ${response.statusText}):${bodyText}` }],
                            details: { url: params.url, status: response.status, ok: false, cached: false },
                            isError: true,
                        };
                    }

                    const data = await response.json() as unknown as FetchResponse;
                    markdown = extractContentText(data.content);
                    title = data.title ?? undefined;
                    finalUrl = data.url ?? params.url;
                    status = response.status;
                    fromCache = false;
                    // Cache the fetched content for later requests to the same URL.
                    await cache.set(params.url, markdown);
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    const aborted = controller.signal.aborted;
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: aborted
                                    ? `webfetch aborted (timeout after ${timeoutMs}ms or canceled): ${params.url}`
                                    : `Failed to fetch ${params.url}: ${message}`,
                            },
                        ],
                        details: { url: params.url, ok: false, cached: false },
                        isError: true,
                    };
                }
                finally {
                    clearTimeout(timeoutId);
                    if (outerSignal) outerSignal.removeEventListener("abort", abortFromEither);
                }
            }

            // Pass 2: sanitize via pi session (single path for cache + network).
            try {
                const result = await sanitizeWithPiSession(ctx.modelRegistry, markdown, params.prompt, { signal });
                return {
                    content: [{ type: "text" as const, text: result }],
                    details: {
                        url: finalUrl,
                        title,
                        status,
                        ok: true,
                        cached: fromCache,
                    },
                };
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: fromCache
                                ? `Failed to process cached content for ${params.url}: ${message}`
                                : `Failed to sanitize content for ${params.url}: ${message}`,
                        },
                    ],
                    details: {
                        url: params.url,
                        status,
                        ok: false,
                        cached: fromCache,
                    },
                    isError: true,
                };
            }
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
