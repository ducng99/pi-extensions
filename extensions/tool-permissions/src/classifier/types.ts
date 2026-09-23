import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/**
 * Shared plumbing for the bash-command classifier backends
 * (`./text-classifier.ts` and `./llm.ts`): provider auth resolution, request
 * headers, label validation, and the {@link ClassifierError} type.
 */

// ============================================================================
// Types
// ============================================================================

/** A fully resolved configuration (provider auth + defaults applied). */
export interface ResolvedClassifierConfig {
    baseUrl: string;
    apiKey?: string;
    headers?: Record<string, string | null>;
}

/** A validated classifier label. */
export type ClassifierLabel = "allow" | "ask" | "deny";

/** Error thrown when a classifier endpoint cannot be reached or misbehaves. */
export class ClassifierError extends Error {
    override name = "ClassifierError";

    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
    }
}

// ============================================================================
// Provider Auth
// ============================================================================

/**
 * Resolve a provider's base URL / API key / headers from the pi model
 * manager, so nothing is hard-coded or read from ad-hoc env vars.
 *
 * Throws {@link ClassifierError} when the provider has no resolvable auth
 * (e.g. it was never logged in or the model manager cannot reach it).
 */
export async function resolveProviderConfig(
    modelRegistry: ModelRegistry,
    provider: string,
): Promise<ResolvedClassifierConfig> {
    let auth;
    try {
        auth = await modelRegistry.getProviderAuth(provider);
    }
    catch (err) {
        throw new ClassifierError(`Failed to resolve auth for provider "${provider}": ${String(err)}`, { cause: err });
    }

    const baseUrl = auth?.auth.baseUrl;
    if (!baseUrl) {
        throw new ClassifierError(
            `Provider "${provider}" has no base URL configured in the model manager. `
            + `Log in with "/login ${provider}" or configure it in models.json.`,
        );
    }

    return {
        baseUrl,
        apiKey: auth?.auth.apiKey,
        headers: auth?.auth.headers,
    };
}

/**
 * Build the request headers from the resolved provider auth: provider
 * headers (minus any `Authorization`, which is set from the API key), then
 * `Authorization: Bearer <apiKey>` when a key is present.
 */
export function buildRequestHeaders(resolved: ResolvedClassifierConfig): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    for (const [key, value] of Object.entries(resolved.headers ?? {})) {
        if (value === null) continue;
        if (key.toLowerCase() !== "authorization") headers[key] = value;
    }
    if (resolved.apiKey) {
        headers["Authorization"] = `Bearer ${resolved.apiKey}`;
    }
    return headers;
}

/**
 * Validate and normalize a raw label value from a classifier response.
 * Throws {@link ClassifierError} for anything outside allow/ask/deny.
 */
export function normalizeLabel(label: unknown): ClassifierLabel {
    const normalized = typeof label === "string" ? label.trim().toLowerCase() : "";
    if (normalized === "allow" || normalized === "ask" || normalized === "deny") {
        return normalized;
    }
    throw new ClassifierError(`Classifier returned unknown label "${String(label)}"`);
}
