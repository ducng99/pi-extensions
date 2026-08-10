/**
 * Webfetch Tool
 *
 * Fetches a URL, extracts the body, converts HTML to markdown,
 * and sanitizes the content via an isolated pi session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { WebContentCache } from "../shared/web-content-cache/index";
import { extractBody, isHtmlContentType } from "./html";
import { htmlToMarkdown } from "./markdown";
import { sanitizeWithPiSession } from "./sanitize";
import { WebFetchParams } from "./schema";

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** Structured details returned for every webfetch result. */
interface WebFetchDetails {
    ok: boolean;
    url: string;
    cached: boolean;
    status?: number;
    /** Set when the request was redirected; the caller should fetch this URL instead. */
    redirect?: string;
    contentType?: string | null;
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
- When a URL redirects to a different host, the tool will inform you and provide the redirect URL in a special format. You should then make a new WebFetch request with the redirect URL to fetch the content.
- For GitHub URLs, prefer using the gh CLI via Bash instead (e.g., gh pr view, gh issue view, gh api).
        `.trim(),
        promptGuidelines: [
            "Use webfetch when you need the summarized content of a specific URL.",
        ],
        parameters: WebFetchParams,

        async execute(_toolCallId, params, signal) {
            const timeoutMs = params.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

            // Pass 1: obtain the markdown. A cache hit (e.g. from websearch)
            // gives us the already-converted markdown directly; otherwise we
            // fetch the URL and convert HTML→markdown.
            let markdown: string;
            let contentType: string | null;
            let status: number;
            let fromCache: boolean;

            const cachedMarkdown = await cache.get(params.url);
            if (cachedMarkdown !== undefined) {
                markdown = cachedMarkdown;
                contentType = null;
                status = 200;
                fromCache = true;
            }
            else {
                const controller = new AbortController();
                const outerSignal = signal ?? undefined;
                const abortFromEither = () => controller.abort();
                if (outerSignal) {
                    if (outerSignal.aborted) controller.abort();
                    else outerSignal.addEventListener("abort", abortFromEither, { once: true });
                }
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

                try {
                    const response = await fetch(params.url, { signal: controller.signal, redirect: "manual" });

                    // Don't follow redirects: surface the target URL so the caller
                    // can issue a fresh WebFetch for it (as the tool description says).
                    // `redirect: "manual"` hands us the redirect response (3xx) with a
                    // `location` header instead of transparently following it.
                    const location = response.headers.get("location");
                    const isRedirect = response.status >= 300 && response.status < 400 && location !== null;
                    if (isRedirect) {
                        const redirectUrl = new URL(location, params.url).toString();
                        return {
                            content: [
                                {
                                    type: "text" as const,
                                    text: `Status: ${response.status}. Redirect URL: ${redirectUrl}\nThe requested URL redirected. Fetch the redirect URL above to retrieve the content.`,
                                },
                            ],
                            details: {
                                ok: false,
                                url: params.url,
                                cached: false,
                                status: response.status,
                                redirect: redirectUrl,
                            },
                            isError: false,
                        };
                    }

                    const rawBody = await response.text();

                    if (!response.ok) {
                        const bodyText = rawBody.length > 0 ? `\n${rawBody}` : "";
                        return {
                            content: [{ type: "text" as const, text: `Failed to fetch ${params.url} (${response.status} ${response.statusText}):${bodyText}` }],
                            details: { url: params.url, status: response.status, ok: false, contentType: response.headers.get("content-type") ?? undefined, cached: false },
                            isError: true,
                        };
                    }

                    contentType = response.headers.get("content-type");
                    markdown = isHtmlContentType(contentType)
                        ? htmlToMarkdown(extractBody(rawBody))
                        : rawBody;
                    // Cache the fetched content for later requests to the same URL.
                    await cache.set(params.url, markdown);
                    status = response.status;
                    fromCache = false;
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
                const result = await sanitizeWithPiSession(markdown, params.prompt, { signal });
                return {
                    content: [{ type: "text" as const, text: result }],
                    details: {
                        url: params.url,
                        status,
                        ok: true,
                        contentType: contentType ?? undefined,
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
                        contentType: contentType ?? undefined,
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
