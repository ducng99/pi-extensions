import { ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { PermissionDecision } from "./permission-check";
import type { ClassifierSessionContext } from "./session-context";

/**
 * Classifies a bash command as allow / ask / deny by querying an OpenAI-compatible
 * chat completions endpoint through pi's model manager.
 *
 * The model outputs one of three labels (allow, ask, deny). The winning label
 * is chosen via softmax over the token logprobs at the first generated position.
 */

// ============================================================================
// Types
// ============================================================================

/** A chat message sent to the classifier endpoint. */
interface ChatMessage {
    role: "system" | "user";
    content: string;
}

/** A fully resolved configuration (provider auth + defaults applied). */
interface ResolvedClassifierConfig {
    baseUrl: string;
    apiKey?: string;
    headers?: Record<string, string | null>;
}

// ============================================================================
// Defaults
// ============================================================================

const PROVIDER = "llama.cpp";
const MODEL = "cmd-classifier";
const TIMEOUT_MS = 10_000;
// Warmup gets a much longer budget: its whole point is to absorb the model's
// one-time lazy load (llama.cpp can take minutes for large models), which
// would otherwise blow the 10s probe timeout on the first real classification.
const WARMUP_TIMEOUT_MS = 60_000;
const ALLOW_CONFIDENCE_THRESHOLD = 0.8;

let config: ResolvedClassifierConfig | null = null;

/**
 * Resolve user-provided options against the pi model manager. The provider's
 * base URL / API key / headers come from `modelRegistry.getProviderAuth()`,
 * so nothing is hard-coded or read from ad-hoc env vars here.
 *
 * Throws {@link ClassifierError} when the provider has no resolvable auth
 * (e.g. it was never logged in or the model manager cannot reach it).
 */
export async function loadClassifier(modelRegistry: ModelRegistry) {
    let auth;
    try {
        auth = await modelRegistry.getProviderAuth(PROVIDER);
    }
    catch (err) {
        throw new ClassifierError(`Failed to resolve auth for provider "${PROVIDER}": ${String(err)}`, { cause: err });
    }

    const baseUrl = auth?.auth.baseUrl;
    if (!baseUrl) {
        throw new ClassifierError(
            `Provider "${PROVIDER}" has no base URL configured in the model manager. `
            + `Log in with "/login ${PROVIDER}" or configure it in models.json.`,
        );
    }

    config = {
        baseUrl,
        apiKey: auth?.auth.apiKey,
        headers: auth?.auth.headers,
    };

    // Kick off the model load on the server without blocking: see the module
    // doc comment. Errors are swallowed — warmup is best-effort and any real
    // problem will surface through `classifyBashCommand`.
    warmupModel();
}

/**
 * Fire-and-forget warmup probe that forces the model server to load the model
 * into memory now, instead of on the first real classification (which can take
 * tens of seconds with llama.cpp and blow the probe timeout).
 */
function warmupModel() {
    requestScore(buildProbe("echo warmup"), { timeoutMs: WARMUP_TIMEOUT_MS }).catch(() => {});
}

// ============================================================================
// Prompt Building
// ============================================================================

const SYSTEM_PROMPT = "You are a strict safety moderator reviewing shell commands. You only answer `allow` or `ask` or `deny`";

/**
 * Render a {@link ClassifierSessionContext} as the compact `<SessionContext>`
 * block the policy expects. Returns the block with leading/trailing newlines
 * so it slots cleanly into the probe, or an empty string when the context is
 * absent (warmup, no-git-repo case).
 */
function renderSessionContext(ctx: ClassifierSessionContext | undefined): string {
    if (!ctx) return "";
    const lines: string[] = [];
    lines.push(`cwd: ${ctx.cwd}`);
    if (ctx.gitRemote) lines.push(`gitRemote: ${ctx.gitRemote}`);
    if (ctx.recentToolCalls?.length) lines.push(`recentToolCalls: ${ctx.recentToolCalls.join(" | ")}`);
    if (ctx.agentTouchedFiles?.length) lines.push(`agentTouchedFiles: ${ctx.agentTouchedFiles.join(", ")}`);
    if (ctx.lastUserPrompt) lines.push(`lastUserPrompt: ${ctx.lastUserPrompt}`);
    if (ctx.gitStatus) lines.push(`gitStatus:\n${ctx.gitStatus}`);
    if (lines.length === 0) return "";
    const block = lines.join("\n");
    return `<SessionContext>\n${block}\n</SessionContext>`;
}

/**
 * Build the single probe message list for a bash command.
 */
function buildProbe(command: string, sessionContext?: ClassifierSessionContext): ChatMessage[] {
    return [
        { role: "system", content: SYSTEM_PROMPT },
        {
            role: "user",
            content: `${renderSessionContext(sessionContext)}\n\n${command}`,
        },
    ];
}

// ============================================================================
// OpenAI-Compatible API Call
// ============================================================================

/** Reference allow / ask / deny tokens (after trim + lowercase). */
const ALLOW_TOKENS = new Set(["allow", "allow.", "\"allow\"", "'allow'"]);
const ASK_TOKENS = new Set(["ask", "ask.", "\"ask\"", "'ask'"]);
const DENY_TOKENS = new Set(["deny", "deny.", "\"deny\"", "'deny'"]);

const LABELS = ["allow", "ask", "deny"] as const;
const LABEL_TOKENS: Record<string, Set<string>> = {
    allow: ALLOW_TOKENS,
    ask: ASK_TOKENS,
    deny: DENY_TOKENS,
};

interface TopLogprob {
    token: string;
    logprob: number;
}

/** Error thrown when the classifier endpoint cannot be reached or misbehaves. */
export class ClassifierError extends Error {
    override name = "ClassifierError";

    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
    }
}

type Json = Record<string, unknown>;

/**
 * Extract the `top_logprobs` of the first generated position from an OpenAI-
 * compatible chat completions response (shape: `choices[0].logprobs.content[0]
 * .top_logprobs`). Returns an empty list when the shape is unexpected.
 */
function extractTopLogprobs(json: Json): TopLogprob[] {
    const choices = json["choices"];
    if (!Array.isArray(choices) || choices.length === 0) return [];

    const firstChoice = choices[0];
    if (typeof firstChoice !== "object" || firstChoice === null) return [];

    const logprobs = (firstChoice as Json)["logprobs"];
    if (typeof logprobs !== "object" || logprobs === null) return [];

    const content = (logprobs as Json)["content"];
    if (!Array.isArray(content) || content.length === 0) return [];

    const firstPosition = content[0];
    if (typeof firstPosition !== "object" || firstPosition === null) return [];

    const top = (firstPosition as Json)["top_logprobs"];
    if (!Array.isArray(top)) return [];

    const result: TopLogprob[] = [];
    for (const entry of top) {
        if (typeof entry !== "object" || entry === null) continue;
        const e = entry as Json;
        const token = e["token"];
        const logprob = e["logprob"];
        if (typeof token !== "string" || typeof logprob !== "number") continue;
        result.push({ token, logprob });
    }
    return result;
}

/**
 * Build the request headers from the resolved provider auth: provider
 * headers (minus any `Authorization`, which is set from the API key), then
 * `Authorization: Bearer <apiKey>` when a key is present.
 */
function buildRequestHeaders(resolved: ResolvedClassifierConfig): Record<string, string> {
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
 * POST `messages` to the endpoint's `/chat/completions` with `max_tokens=1`
 * and token logprobs, then return a {@link PermissionDecision} based on
 * the highest-probability label (allow / ask / deny) via softmax.
 *
 * Throws {@link ClassifierError} on network failures, HTTP errors, or a
 * response without usable logprobs.
 */
interface RequestOptions {
    /** Caller's abort signal (e.g. session abort); combined with the timeout. */
    signal?: AbortSignal;
    /** Request timeout in ms (defaults to {@link TIMEOUT_MS}). */
    timeoutMs?: number;
}

async function requestScore(messages: ChatMessage[], options: RequestOptions = {}): Promise<PermissionDecision> {
    if (!config) throw new ClassifierError("Classifier config not loaded");

    const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

    const payload = {
        model: MODEL,
        messages,
        max_tokens: 1,
        logprobs: true,
        top_logprobs: 20,
    };

    // Always enforce the timeout, and also honour the caller's signal
    // (e.g. session abort) — whichever fires first aborts the request.
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS);
    const combinedSignal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

    let response: Response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: buildRequestHeaders(config),
            body: JSON.stringify(payload),
            signal: combinedSignal,
        });
    }
    catch (err) {
        throw new ClassifierError(`Failed to reach classifier at ${url}: ${String(err)}`, { cause: err });
    }

    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new ClassifierError(`Classifier request failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    const json = (await response.json()) as Json;
    const top = extractTopLogprobs(json);
    if (top.length === 0) {
        throw new ClassifierError("Classifier response contained no usable logprobs");
    }

    // Softmax over the allow/ask/deny logits at the first generated position.
    const MISSING_LOGIT = -10.0;
    const z: Record<string, number> = { allow: MISSING_LOGIT, ask: MISSING_LOGIT, deny: MISSING_LOGIT };
    for (const tok of top) {
        const t = tok.token.trim().toLowerCase();
        for (const label of LABELS) {
            if (LABEL_TOKENS[label]!.has(t)) {
                z[label] = Math.max(z[label]!, tok.logprob);
            }
        }
    }

    const expVals = LABELS.map(l => Math.exp(z[l]!));
    const total = expVals.reduce((a, b) => a + b, 0);
    const probs = Object.fromEntries(LABELS.map((l, i) => [l, expVals[i]! / total])) as Record<string, number>;

    // Return the label with highest probability.
    let bestLabel: "allow" | "ask" | "deny" = "ask";
    let bestProb = -1;
    for (const label of LABELS) {
        if (probs[label]! > bestProb) {
            bestProb = probs[label]!;
            bestLabel = label;
        }
    }

    // Downgrade to ask when the model says allow but isn't confident enough.
    const allowProb = probs.allow!;
    if (bestLabel === "allow" && allowProb < ALLOW_CONFIDENCE_THRESHOLD) {
        return { decision: "ask", reason: `Auto mode: allow confidence ${allowProb.toFixed(2)} < ${ALLOW_CONFIDENCE_THRESHOLD} threshold` };
    }

    return { decision: bestLabel, reason: `Auto mode (allow=${probs.allow!.toFixed(2)}, ask=${probs.ask!.toFixed(2)}, deny=${probs.deny!.toFixed(2)})` };
}

/**
 * Classify a bash command as allow / ask / deny. The endpoint and key are resolved
 * from the `llama.cpp` provider via the model manager (see the module docs).
 *
 * Throws {@link ClassifierError} if auth cannot be resolved or the probe
 * fails.
 */
export async function classifyBashCommand(
    command: string,
    signal?: AbortSignal,
    sessionContext?: ClassifierSessionContext,
): Promise<PermissionDecision> {
    try {
        return await requestScore(buildProbe(command, sessionContext), { signal });
    }
    catch (err) {
        return { decision: "ask", reason: "Classifier probe failed\n" + String(err) };
    }
}
