import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { PermissionDecision } from "../permission-check";
import type { ClassifierSessionContext } from "../session-context";
import { buildRequestHeaders, ClassifierError, type ClassifierLabel, type ResolvedClassifierConfig, resolveProviderConfig } from "./types";

/**
 * Text-classifier backend: classifies a tool call as allow / ask / deny by
 * querying the classifier server's `/autoshell` endpoint through pi's model
 * manager.
 *
 * Request body:
 * ```json
 * {
 *   "command": "echo \"docker processes\" ; docker ps",
 *   "shell": "posix",
 *   "context": { "cwd": "/home/user", "lastUserPrompt": "check the running docker processes" }
 * }
 * ```
 * `context` is the full {@link ClassifierSessionContext} (cwd, gitRemote,
 * gitStatus, recentToolCalls, agentTouchedFiles, lastUserPrompt). No
 * assistant message is part of it — the tool call is the top-level `command`
 * field (bash passes its raw command; other tools are serialized as
 * `toolName <arg>`), and model-authored prose is never sent, so it cannot
 * steer the verdict.
 *
 * Response body:
 * ```json
 * {"label":"ask","probabilities":{"allow":0.1436,"ask":0.8523,"deny":0.0041},"confidence":0.8523,"risk":0.4302,"input_tokens":42}
 * ```
 * The decision is derived from `probabilities` (they are fractions 0-1 that
 * sum to 1; the `label` / `confidence` fields are informational): the label
 * with the highest probability wins, and allow/deny only sticks when that
 * probability is >= {@link CONFIDENCE_THRESHOLD} — otherwise ask.
 */

// ============================================================================
// Defaults
// ============================================================================

const PROVIDER = "aimachine";
const SHELL = "posix";
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
    // problem will surface through `classifyToolCall`.
    warmupModel();
}

/**
 * Fire-and-forget warmup probe that forces the model server to load the model
 * into memory now, instead of on the first real classification (which can take
 * tens of seconds with llama.cpp and blow the probe timeout).
 */
function warmupModel() {
    requestDecision(buildBody("bash", { command: "echo warmup" }), { timeoutMs: WARMUP_TIMEOUT_MS }).catch(() => {});
}

// ============================================================================
// Request Building
// ============================================================================

/** POST body for the classifier endpoint. */
interface ClassifierRequestBody {
    /** The tool call under evaluation, rendered as a command string. */
    command: string;
    /** Shell dialect the command is written in. */
    shell: typeof SHELL;
    /** Full session context (omitted for warmup). No assistant message. */
    context?: ClassifierSessionContext;
}

/**
 * Render a tool call as the `command` string the endpoint expects: bash
 * passes its raw command through, every other tool is serialized as
 * `toolName <primary arg>` (e.g. `edit /path/to/file`).
 */
function renderToolCall(toolName: string, input: Record<string, unknown>): string {
    if (toolName === "bash") return typeof input.command === "string" ? input.command : "";
    const argString = buildToolArgString(toolName, input);
    return argString ? `${toolName} ${argString}` : toolName;
}

/** Primary argument of a tool call, used for classifier rendering. */
function buildToolArgString(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
        case "edit":
        case "write":
        case "read":
        case "ls":
        case "find":
            return typeof input.path === "string" ? input.path : "";
        case "grep":
            return typeof input.pattern === "string" ? input.pattern : "";
        case "webfetch":
            return typeof input.url === "string" ? input.url : "";
        case "subagent":
            return typeof input.agent === "string" ? input.agent : "";
        default:
            return "";
    }
}

/**
 * Build the request body for a tool call: its rendered command, the shell
 * dialect, and the session context as structured JSON (absent during warmup).
 */
function buildBody(toolName: string, input: Record<string, unknown>, sessionContext?: ClassifierSessionContext): ClassifierRequestBody {
    const body: ClassifierRequestBody = { command: renderToolCall(toolName, input), shell: SHELL };
    if (sessionContext) body.context = sessionContext;
    return body;
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
 * Label vocabulary, ordered — used to read the `probabilities` map.
 */
const LABEL_ORDER: ClassifierLabel[] = ["allow", "ask", "deny"];

/**
 * Read one label's probability out of the response's `probabilities` map.
 *
 * Throws {@link ClassifierError} when the value is missing or not a finite
 * number (the caller degrades that to `ask`).
 */
function readProbability(probs: Record<string, unknown>, key: ClassifierLabel): number {
    const raw = probs[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
        throw new ClassifierError(`Classifier response is missing a numeric "${key}" probability`);
    }
    return raw;
}

/**
 * POST the command + session context to the endpoint's `/autoshell` route and
 * map the returned probabilities to a {@link PermissionDecision}: allow/deny
 * only at >= {@link CONFIDENCE_THRESHOLD} confidence, otherwise ask.
 *
 * Throws {@link ClassifierError} on network failures, HTTP errors, or a
 * malformed response.
 */
async function requestDecision(body: ClassifierRequestBody, options: RequestOptions = {}): Promise<PermissionDecision> {
    if (!config) throw new ClassifierError("Classifier config not loaded");

    const url = new URL("/autoshell", config.baseUrl);

    // Always enforce the timeout, and also honour the caller's signal
    // (e.g. session abort) — whichever fires first aborts the request.
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS);
    const combinedSignal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

    let response: Response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: buildRequestHeaders(config),
            body: JSON.stringify(body),
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
    const rawProbs = json["probabilities"];
    if (typeof rawProbs !== "object" || rawProbs === null) {
        throw new ClassifierError(`Classifier response had unexpected shape: ${JSON.stringify(json)}`);
    }
    const probs = rawProbs as Record<string, unknown>;

    // The winning label is the most probable one (probabilities sum to 1, so
    // allow/deny at >= 0.8 is always the argmax — the two readings agree).
    let label: ClassifierLabel = "allow";
    let score = -Infinity;
    for (const key of LABEL_ORDER) {
        const value = readProbability(probs, key);
        if (value > score) {
            score = value;
            label = key;
        }
    }

    // Downgrade to ask when the model says allow/deny but isn't confident enough.
    if ((label === "allow" || label === "deny") && score < CONFIDENCE_THRESHOLD) {
        return { decision: "ask", reason: `Auto mode: ${label} confidence ${score.toFixed(2)} < ${CONFIDENCE_THRESHOLD} threshold` };
    }

    return { decision: label, reason: `Auto mode (label=${label}, score=${score.toFixed(2)})` };
}

/**
 * Classify a tool call as allow / ask / deny. The endpoint and key are resolved
 * from the `aimachine` provider via the model manager (see the module docs).
 *
 * Never throws — request failures degrade to an `ask` decision so the user
 * gets the final say.
 */
export async function classifyToolCall(
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    sessionContext?: ClassifierSessionContext,
): Promise<PermissionDecision> {
    try {
        return await requestDecision(buildBody(toolName, input, sessionContext), { signal });
    }
    catch (err) {
        return { decision: "ask", reason: "Classifier request failed\n" + String(err) };
    }
}
