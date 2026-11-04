/**
 * Minimal Firecrawl `/v2/scrape` client using direct fetch.
 */

interface ScrapeResponse {
    success?: boolean;
    error?: string;
    data?: {
        markdown?: string;
        answer?: string | null;
        metadata?: { title?: string; url?: string; sourceURL?: string; statusCode?: number };
    };
}

export interface ScrapeResult {
    markdown: string;
    answer?: string;
    title?: string;
    url?: string;
    status: number;
}

export class FirecrawlError extends Error {
    constructor(message: string, readonly status?: number) {
        super(message);
    }
}

async function post<T>(url: string, apiKey: string, body: unknown, signal: AbortSignal): Promise<T> {
    const response = await fetch(url, {
        method: "POST",
        signal,
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new FirecrawlError(`${response.status} ${response.statusText}${text ? `\n${text}` : ""}`, response.status);
    }
    return await response.json() as T;
}

export async function scrapeUrl(baseUrl: string, apiKey: string, url: string, prompt: string | undefined, signal: AbortSignal): Promise<ScrapeResult> {
    const endpoint = `${baseUrl.replace(/\/+$/, "")}/v2/scrape`;

    const formats: Array<string | { type: "question"; question: string }> = ["markdown"];
    if (prompt) {
        formats.push({ type: "question", question: prompt });
    }

    const response = await post<ScrapeResponse>(endpoint, apiKey, {
        url,
        formats,
        onlyMainContent: true,
    }, signal);

    const data = response.data;
    if (!response.success || !data?.markdown) {
        throw new FirecrawlError(response.error ?? "Firecrawl returned no content");
    }

    return {
        markdown: data.markdown,
        answer: data.answer ?? undefined,
        title: data.metadata?.title,
        url: data.metadata?.url ?? data.metadata?.sourceURL,
        status: data.metadata?.statusCode ?? 200,
    };
}
