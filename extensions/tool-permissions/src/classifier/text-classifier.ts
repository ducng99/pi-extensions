import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { PermissionDecision } from "../permission-check";
import type { ClassifierSessionContext } from "../session-context";
import { buildRequestHeaders, ClassifierError, normalizeLabel, type ResolvedClassifierConfig, resolveProviderConfig } from "./types";

/**
 * Text-classifier backend: classifies a bash command as allow / ask / deny by
 * querying the classifier server's `/autoshell` endpoint through pi's model
 * manager.
 *
 * The request body is `{"text": "..."}`; the response is
 * `{"label": "allow" | "ask" | "deny", "score": <confidence>}`.
 */

// ============================================================================
// Defaults
// ============================================================================

const PROVIDER = "aimachine";
const TIMEOUT_MS = 10_000;
// Warmup gets a much longer budget: its whole point is to absorb the model's
// one-time lazy load (llama.cpp can take minutes for large models), which
// would otherwise blow the 10s probe timeout on the first real classification.
const WARMUP_TIMEOUT_MS = 60_000;
const CONFIDENCE_THRESHOLD = 0.8;

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
    config = await resolveProviderConfig(modelRegistry, PROVIDER);

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
    requestScore(buildText("echo warmup"), { timeoutMs: WARMUP_TIMEOUT_MS }).catch(() => {});
}

// ============================================================================
// Text Building
// ============================================================================

/**
 * Render a {@link ClassifierSessionContext} as the compact `<SessionContext>`
 * block the policy expects. Returns the block with leading/trailing newlines
 * so it slots cleanly into the text, or an empty string when the context is
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
 * Build the request text for a bash command.
 */
function buildText(command: string, sessionContext?: ClassifierSessionContext): string {
    return `${renderSessionContext(sessionContext)}\n\n${command}`;
}

// ============================================================================
// Classifier API Call
// ============================================================================

interface RequestOptions {
    /** Caller's abort signal (e.g. session abort); combined with the timeout. */
    signal?: AbortSignal;
    /** Request timeout in ms (defaults to {@link TIMEOUT_MS}). */
    timeoutMs?: number;
}

/**
 * POST `{"text"}` to the endpoint's `/autoshell` route and map the returned
 * label / score pair to a {@link PermissionDecision}.
 *
 * Throws {@link ClassifierError} on network failures, HTTP errors, or a
 * malformed response.
 */
async function requestScore(text: string, options: RequestOptions = {}): Promise<PermissionDecision> {
    if (!config) throw new ClassifierError("Classifier config not loaded");

    const url = new URL("/autoshell", config.baseUrl);

    const payload = { text };

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

    const json = (await response.json()) as Record<string, unknown>;
    const score = json["score"];
    if (typeof score !== "number" || !Number.isFinite(score)) {
        throw new ClassifierError(`Classifier response had unexpected shape: ${JSON.stringify(json)}`);
    }

    const normalized = normalizeLabel(json["label"]);

    // Downgrade to ask when the model says allow/deny but isn't confident enough.
    if ((normalized === "allow" || normalized === "deny") && score < CONFIDENCE_THRESHOLD) {
        return { decision: "ask", reason: `Auto mode: ${normalized} confidence ${score.toFixed(2)} < ${CONFIDENCE_THRESHOLD} threshold` };
    }

    return { decision: normalized, reason: `Auto mode (label=${normalized}, score=${score.toFixed(2)})` };
}

/**
 * Classify a bash command as allow / ask / deny. The endpoint and key are resolved
 * from the `aimachine` provider via the model manager (see the module docs).
 *
 * Never throws — request failures degrade to an `ask` decision so the user
 * gets the final say.
 */
export async function classifyBashCommand(
    command: string,
    signal?: AbortSignal,
    sessionContext?: ClassifierSessionContext,
): Promise<PermissionDecision> {
    try {
        return await requestScore(buildText(command, sessionContext), { signal });
    }
    catch (err) {
        return { decision: "ask", reason: "Classifier request failed\n" + String(err) };
    }
}
