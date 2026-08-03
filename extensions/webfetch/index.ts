/**
 * Webfetch Tool
 *
 * Fetches a URL, extracts the body, converts HTML to markdown,
 * and sanitizes the content via an isolated pi session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { extractBody, isHtmlContentType } from "./html";
import { htmlToMarkdown } from "./markdown";
import { sanitizeWithPiSession } from "./sanitize";
import { WebFetchParams } from "./schema";

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export default function webfetchTool(pi: ExtensionAPI) {
    pi.registerTool({
        name: "webfetch",
        label: "Web Fetch",
        description: "Fetch the given URL and return the raw response body as text.",
        promptSnippet: "Fetch a URL and return its response body",
        promptGuidelines: [
            "Use webfetch when you need the raw content of a specific URL.",
            "Use websearch to discover relevant URLs before calling webfetch.",
        ],
        parameters: WebFetchParams,

        async execute(_toolCallId, params, signal) {
            const timeoutMs = params.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
            const controller = new AbortController();
            const outerSignal = signal ?? undefined;

            const abortFromEither = () => controller.abort();
            if (outerSignal) {
                if (outerSignal.aborted) controller.abort();
                else outerSignal.addEventListener("abort", abortFromEither, { once: true });
            }
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

            try {
                const response = await fetch(params.url, { signal: controller.signal, redirect: "follow" });
                const rawBody = await response.text();

                if (!response.ok) {
                    const bodyText = rawBody.length > 0 ? `\n${rawBody}` : "";
                    return {
                        content: [{ type: "text" as const, text: `Failed to fetch ${params.url} (${response.status} ${response.statusText}):${bodyText}` }],
                        details: { url: params.url, status: response.status, statusText: response.statusText, contentLength: rawBody.length, ok: false, contentType: response.headers.get("content-type") ?? undefined },
                        isError: true,
                    };
                }

                // Pass 1: extract body + convert to markdown
                const contentType = response.headers.get("content-type");
                const markdown = isHtmlContentType(contentType)
                    ? htmlToMarkdown(extractBody(rawBody))
                    : rawBody;

                // Pass 2: sanitize via pi session
                const sanitized = await sanitizeWithPiSession(markdown, params.prompt);

                return {
                    content: [{ type: "text" as const, text: sanitized }],
                    details: {
                        url: params.url,
                        status: response.status,
                        statusText: response.statusText,
                        contentLength: rawBody.length,
                        ok: true,
                        contentType: contentType ?? undefined,
                    },
                };
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
                    details: { url: params.url, status: 0, statusText: "", contentLength: 0, ok: false, contentType: undefined },
                    isError: true,
                };
            }
            finally {
                clearTimeout(timeoutId);
                if (outerSignal) outerSignal.removeEventListener("abort", abortFromEither);
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
