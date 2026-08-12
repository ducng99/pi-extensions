import { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { INSTRUCT } from "./classifier-instructions";
import type { PermissionDecision } from "./permission-check";
import type { ClassifierSessionContext } from "./session-context";

/**
 * Classifies a bash command as allow / ask by querying an OpenAI-compatible
 * chat completions endpoint through pi's model manager.
 *
 * The endpoint (base URL + API key) is resolved from a registered provider
 * via `ModelRegistry.getProviderAuth()` — no URL/key is hard-coded here. The
 * default provider is `llama.cpp` and the default model is `cmd-classifier`.
 *
 * `loadClassifier()` also fires a fire-and-forget warmup probe so the model
 * server loads the model into memory up front — llama.cpp loads models lazily
 * on first request, which can take far longer than the probe timeout and
 * would otherwise make the first real classification fail.
 *
 * A single probe is sent: one `<Instruct>` (the moderation policy), one
 * `<Query>` (the yes/no question), an optional compact `<SessionContext>`
 * block (cwd, git remote/status, recent tool activity, agent-touched paths,
 * last user prompt) appended when the caller supplies one, and the command
 * in `<Document>`. The model is expected to emit a single `yes` / `no` token;
 * mirroring the reference judge-model evaluation pattern, we request
 * `max_tokens=1` with token logprobs (`logprobs=true, top_logprobs=20`) and
 * renormalise the `yes` and `no` probabilities into a continuous score in
 * [0, 1].
 *
 * The score maps to a binary decision:
 *   - score <= threshold → allow
 *   - otherwise          → ask
 *
 * `confidence` is how decisive the score is: `score` for an ask, `1 - score`
 * for an allow.
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
const THRESHOLD = 0.1;

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
    requestScore(buildProbe("echo warmup"), { timeoutMs: WARMUP_TIMEOUT_MS }).catch();
}

// ============================================================================
// Prompt Building
// ============================================================================

const SYSTEM_PROMPT = "Judge whether the Document meets the requirements based on the Query and the Instruction provided. Note that the answer can only be \"yes\" or \"no\".";

// The moderation policy lives in `<Instruct>` / `<Query>`; the content (the
// bash command) goes in `<Document>`. When the caller supplies session
// context, a compact `<SessionContext>` block is interposed between
// `<Query>` and `<Document>` so the policy's session-aware rules can see it.
const QUERY = "Is this shell command safe to run?";

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
    if (ctx.gitStatus) lines.push("gitStatus:"); // multi-line follows below
    if (ctx.recentToolCalls?.length) lines.push(`recentToolCalls: ${ctx.recentToolCalls.join(" | ")}`);
    if (ctx.agentTouchedFiles?.length) lines.push(`agentTouchedFiles: ${ctx.agentTouchedFiles.join(", ")}`);
    if (ctx.lastUserPrompt) lines.push(`lastUserPrompt: ${ctx.lastUserPrompt}`);
    if (lines.length === 0) return "";
    let block = lines.join("\n");
    if (ctx.gitStatus) block += `\n${ctx.gitStatus}`;
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
            content: `<Instruct>: ${INSTRUCT}\n\n${renderSessionContext(sessionContext)}\n\n<Query>: ${QUERY}\n\n<Document>: [Assistant] [BashToolCall]: ${command}`,
        },
    ];
}

// ============================================================================
// OpenAI-Compatible API Call
// ============================================================================

/** Reference `yes` / `no` tokens (after trim + lowercase). */
const YES_TOKENS = new Set(["yes", "yes.", "\"yes\"", "'yes'"]);
const NO_TOKENS = new Set(["no", "no.", "\"no\"", "'no'"]);

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
 * and token logprobs, then return the renormalised continuous score
 * `P(yes) / (P(yes) + P(no))` in [0, 1].
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

async function requestScore(messages: ChatMessage[], options: RequestOptions = {}): Promise<number> {
    if (!config) throw new ClassifierError("Classifier config not loaded");

    const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

    const payload = {
        model: MODEL,
        messages,
        max_tokens: 1,
        temperature: 0.0,
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

    // Softmax over the yes/no logits at the first generated position.
    let zYes = -10.0;
    let zNo = -10.0;
    for (const tok of top) {
        const t = tok.token.trim().toLowerCase();
        if (YES_TOKENS.has(t)) {
            zYes = Math.max(zYes, tok.logprob);
        }
        else if (NO_TOKENS.has(t)) {
            zNo = Math.max(zNo, tok.logprob);
        }
    }

    const expYes = Math.exp(zYes);
    const expNo = Math.exp(zNo);
    return expYes / (expYes + expNo);
}

// ============================================================================
// Decision
// ============================================================================

/**
 * Map a probe score to a binary decision: `score <= threshold` → allow,
 * otherwise → ask.
 */
function decide(score: number, threshold: number): PermissionDecision {
    if (score <= threshold) {
        return { decision: "allow", reason: `Allowed by auto mode (score: ${score.toFixed(2)})` };
    }
    return { decision: "ask", reason: `Auto mode threshold not met: ${score.toFixed(2)} (lower = safer)` };
}

/**
 * Classify a bash command as allow / ask. The endpoint and key are resolved
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
        const score = await requestScore(buildProbe(command, sessionContext), { signal });
        return decide(score, THRESHOLD);
    }
    catch (err) {
        return { decision: "ask", reason: "Classifier probe failed\n" + String(err) };
    }
}
