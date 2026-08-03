/**
 * Ollama web search API client.
 *
 * Reference: https://docs.ollama.com/api/web-search
 * Authentication is done via the `OLLAMA_API_KEY` environment variable.
 */

export interface WebSearchResult {
    /** The title of the web page */
    title: string;
    /** The URL of the web page */
    url: string;
    /** Relevant content snippet from the web page */
    content: string;
}

export interface WebSearchResponse {
    results: WebSearchResult[];
}

const WEB_SEARCH_ENDPOINT = "https://ollama.com/api/web_search";

export function getOllamaApiKey(): string | undefined {
    return process.env.OLLAMA_API_KEY;
}

/**
 * Perform a web search through Ollama's web search API.
 *
 * @throws {Error} when the API key is missing or the request fails.
 */
export async function ollamaWebSearch(
    query: string,
    maxResults: number,
    signal?: AbortSignal,
): Promise<WebSearchResponse> {
    const apiKey = getOllamaApiKey();
    if (!apiKey) {
        throw new Error(
            "OLLAMA_API_KEY is not set. Create a key at https://ollama.com/settings/keys "
            + "and expose it via the OLLAMA_API_KEY environment variable.",
        );
    }

    const response = await fetch(WEB_SEARCH_ENDPOINT, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ query, max_results: maxResults }),
        signal,
    });

    if (!response.ok) {
        throw new Error(`Ollama web search failed (${response.status} ${response.statusText}): ${await response.text()}`);
    }

    const data = (await response.json()) as WebSearchResponse;
    if (!Array.isArray(data.results)) {
        throw new Error("Ollama web search returned an unexpected payload.");
    }
    return data;
}
