/**
 * AI Machine web search API client.
 *
 * Calls the `aimachine` provider's `/v1/search` endpoint with a body of
 * `{ model, query, search_type, max_results }`. Auth is resolved through
 * the pi model registry, so the base URL and API key stay in sync with the
 * provider configured in `extensions/router-provider`.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "aimachine";
const SEARCH_MODEL = "search-combo";
const SEARCH_TYPE = "web";

export interface WebSearchResult {
    /** The title of the web page */
    title: string;
    /** The URL of the web page */
    url: string;
    /** Relevant content snippet from the web page */
    snippet: string;
}

export interface WebSearchResponse {
    results: WebSearchResult[];
}

/**
 * Perform a web search through the aimachine provider's `/v1/search`
 * endpoint.
 *
 * @throws {Error} when the provider has no resolvable base URL/API key
 *   (i.e. the user hasn't logged in to the `aimachine` provider) or the
 *   request fails.
 */
export async function aimachineWebSearch(
    query: string,
    maxResults: number,
    modelRegistry: ModelRegistry,
    signal?: AbortSignal,
): Promise<WebSearchResponse> {
    const auth = await modelRegistry.getProviderAuth(PROVIDER_ID).catch((err: unknown) => {
        throw new Error(
            `Failed to resolve auth for provider "${PROVIDER_ID}": ${err instanceof Error ? err.message : String(err)}. `
            + `Log in with "/login ${PROVIDER_ID}" or configure it in models.json.`,
        );
    });

    const baseUrl = auth?.auth.baseUrl;
    if (!baseUrl) {
        throw new Error(
            `Provider "${PROVIDER_ID}" has no base URL configured in the model manager. `
            + `Log in with "/login ${PROVIDER_ID}" or configure it in models.json.`,
        );
    }

    const url = `${baseUrl.replace(/\/+$/, "")}/search`;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    for (const [key, value] of Object.entries(auth.auth.headers ?? {})) {
        if (value === null) continue;
        if (key.toLowerCase() !== "authorization") headers[key] = value;
    }
    if (auth.auth.apiKey) {
        headers["Authorization"] = `Bearer ${auth.auth.apiKey}`;
    }

    const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
            model: SEARCH_MODEL,
            query,
            search_type: SEARCH_TYPE,
            max_results: maxResults,
        }),
        signal,
    });

    if (!response.ok) {
        throw new Error(`AI Machine web search failed (${response.status} ${response.statusText}): ${await response.text()}`);
    }

    const data = (await response.json()) as WebSearchResponse;
    if (!Array.isArray(data.results)) {
        throw new Error("AI Machine web search returned an unexpected payload.");
    }
    return data;
}
