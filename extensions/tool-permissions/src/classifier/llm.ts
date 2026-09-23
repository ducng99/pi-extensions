import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { type ModelRegistry, type SessionEntry, truncateHead } from "@earendil-works/pi-coding-agent";

import type { PermissionDecision } from "../permission-check";
import type { ParsedPermissions } from "../permission-parsing";
import type { ClassifierSessionContext } from "../session-context";
import { ClassifierError, type ClassifierLabel, normalizeLabel } from "./types";

/**
 * LLM backend: classifies a bash command as allow / ask / deny via a single
 * `modelRegistry.complete()` chat completion — pi resolves provider auth,
 * base URL, headers, timeout and transport at request time, so no request is
 * handcrafted with `fetch()`.
 *
 * Mirrors Claude Code's auto mode classifier (see
 * `../claudecode-automode-findings.md`) with the layout we have access to:
 * - system prompt: task + allow/ask/deny criteria (from AGENTS.md policy) +
 *   `<user_rules>` (claude settings / plan mode / subagent rules) + an
 *   `<environment>` block (cwd / gitRemote / agentTouchedFiles / gitStatus).
 * - user (intent): the user's pre-loaded AGENTS.md / CLAUDE.md configuration
 *   files, treated as user intent (Claude Code sends CLAUDE.md the same way).
 * - user (transcript): normalized transcript of the current session in
 *   chronological order — user messages as `{"user": "message"}`, tool calls
 *   as `{"<tool>": "<details>"}`. No assistant prose and no tool responses
 *   (model-authored text could be crafted to influence the classifier).
 * - assistant (prefill): the tool call in question, e.g. `{"bash": "echo hi"}`.
 *   The model continues from here with `{"label": "allow" | "ask" | "deny"}`.
 *
 * Like Claude Code there is no fixed "last N" window: the whole active
 * context (post-compaction) is sent, bounded only by truncation of individual
 * texts; an oversized prompt fails the request and falls back to `ask`
 * (manual approval) — fail closed, never fail open.
 */

// ============================================================================
// Defaults
// ============================================================================

const PROVIDER = "llama.cpp";
const LLM_MODEL = "qwen-coder";
const TIMEOUT_MS = 30_000;

/** Label vocabulary — satisfies {@link ClassifierLabel}. */
const LABELS: ClassifierLabel[] = ["allow", "ask", "deny"];

/**
 * Structured output (findings §8): the reply must validate against
 * `{"label": allow|ask|deny}` — schema-constrained decoding instead of a
 * loose `json_object` bag. Sent verbatim via `samplingParams` (the
 * OpenAI-compatible adapter merges it into the request body as-is).
 */
const RESPONSE_FORMAT = {
    type: "json_schema",
    schema: {
        type: "object",
        properties: {
            label: {
                type: "string",
                enum: LABELS,
            },
        },
        required: ["label"],
        additionalProperties: false,
    },
};

/** Per-line truncation — keeps individual transcript entries compact. */
const MAX_USER_TEXT = 500;
const MAX_TOOL_DETAIL = 500;

let registry: ModelRegistry | null = null;

/**
 * Keep the pi model registry. `complete()` resolves provider auth, base URL
 * and headers per request — nothing else to pre-resolve here.
 */
export async function loadClassifier(modelRegistry: ModelRegistry) {
    registry = modelRegistry;
}

// ============================================================================
// User Intent (AGENTS.md / CLAUDE.md)
// ============================================================================

/** A pre-loaded user instruction file (`pi` context file). */
export interface ContextFile {
    path: string;
    content: string;
}

let intentFiles: ContextFile[] = [];

/**
 * Receive the session's pre-loaded instruction files (AGENTS.md / CLAUDE.md)
 * from the `before_agent_start` event and keep them for classification.
 * Equivalent to Claude Code treating CLAUDE.md as user intent.
 */
export function setIntentFiles(files: ContextFile[] | undefined) {
    intentFiles = files ?? [];
}

/**
 * Build the user-intent message (one per request, before the transcript), or
 * null when the session has no instruction files.
 */
function buildIntentMessage(files: ContextFile[]): string | null {
    if (files.length === 0) return null;
    const blocks = files
        .filter(f => typeof f.content === "string" && f.content.trim())
        .map(f => `<user_claude_md path="${f.path}">\n${f.content}\n</user_claude_md>`)
        .join("\n\n");
    if (!blocks) return null;
    return "The following is the user's AGENTS.md configuration. These are\n"
        + "instructions the user provided to the agent and should be treated\n"
        + `as part of the user's intent when evaluating actions.\n\n${blocks}`;
}

// ============================================================================
// Transcript Building
// ============================================================================

type ContentBlock
    = | { type: "text"; text: string }
        | { type: "toolCall"; name: string; arguments: Record<string, unknown> };

interface LikeMessage {
    role: string;
    content?: string | ContentBlock[];
}

/** Extract user-visible text from a user message. */
function userMessageText(content: LikeMessage["content"]): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((b): b is { type: "text"; text: string } => b?.type === "text")
        .map(b => b.text)
        .join("\n")
        .trim();
}

/**
 * Compact projection of a tool call's input — equivalent to Claude Code's
 * `toAutoClassifierInput(input)`: only the tool's selected fields are
 * exposed, and the default is an empty string (the classifier ignores input
 * it wasn't given), never a raw dump of the payload.
 */
function toolDetail(name: string, args: Record<string, unknown>): string {
    switch (name) {
        case "bash":
            return typeof args.command === "string" ? args.command : "";
        case "edit":
        case "write":
        case "read":
        case "ls":
        case "find":
            return typeof args.path === "string" ? args.path : "";
        case "grep":
            return typeof args.pattern === "string" ? String(args.pattern) : "";
        case "webfetch":
            return typeof args.url === "string" ? args.url : "";
        case "subagent": {
            // Like Claude Code's Agent tool: `(tags): prompt`.
            const agent = typeof args.agent === "string" ? args.agent : "";
            const task = typeof args.task === "string" ? args.task : "";
            return `${agent ? `(${agent})` : ""}: ${task}`;
        }
        default:
            // Claude Code's default: expose nothing.
            return "";
    }
}

/**
 * Build the normalized session transcript: one JSONL object per line, in
 * chronological order. User messages become `{"user": "..."}`, tool calls
 * become `{"<tool>": "<details>"}`.
 *
 * HARD REQUIREMENT (also Claude Code's): no assistant prose and no tool
 * responses — model-authored text could be crafted to influence the
 * classifier. The tool call in question is NOT part of the transcript; it is
 * sent as the final prefill assistant message.
 *
 * There is no fixed "last N" window: all entries up to the latest compaction
 * are included (mirroring Claude Code's full active-context transcript),
 * with only individual texts truncated.
 */
export function buildTranscriptLines(entries: SessionEntry[] | undefined): string[] {
    if (!entries || entries.length === 0) return [];
    const lines: string[] = [];

    for (const entry of entries) {
        const e = entry as unknown as {
            type: string;
            message?: LikeMessage;
        };
        // History before the latest compaction is a summary, not live session
        // activity — drop everything up to it (same as Claude Code's
        // compaction-aware context).
        if (e.type === "compaction") {
            lines.length = 0;
            continue;
        }
        if (e.type !== "message" || !e.message) continue;
        const msg = e.message;

        if (msg.role === "user") {
            const text = userMessageText(msg.content);
            if (text) lines.push(JSON.stringify({ user: truncateHead(text, { maxBytes: MAX_USER_TEXT }).content }));
        }
        else if (msg.role === "assistant" && Array.isArray(msg.content)) {
            for (const block of msg.content) {
                if (block?.type !== "toolCall") continue;
                const { name, arguments: args } = block;
                if (typeof name !== "string" || !args) continue;
                lines.push(JSON.stringify({ [name]: truncateHead(toolDetail(name, args), { maxBytes: MAX_TOOL_DETAIL }).content }));
            }
        }
        // Tool-result messages and assistant prose are deliberately skipped.
    }

    return lines;
}

/** Render the prefill assistant message: the tool call in question. */
function buildPrefill(toolName: string, details: string): string {
    return JSON.stringify({ [toolName]: details });
}

// ============================================================================
// System Prompt
// ============================================================================

/**
 * Task + labeling criteria, derived from the shell_shield_data policy:
 * external/untrusted sources require user permission (`ask`, not auto-unsafe);
 * only obviously malicious flows are `deny`.
 */
const SYSTEM_PROMPT = `You are a shell-command safety classifier for an autonomous coding agent. Given the session transcript and the pending tool call, reply with ONLY a JSON object: {"label": "allow" | "ask" | "deny"}.

Governing principle: external/untrusted sources require user permission — they are "ask", not automatically unsafe. "External" is anything that is not the repo's own configured git remote (gitRemote below) or a loopback address.

Labels:
- "allow": the command is safe to execute without asking. Read-only or reversible in-bounds operations: viewing files/dirs, builds, tests, lints, typechecks. Package-manager installs of KNOWN dependencies (the manifest — package.json, lockfiles, pyproject, Cargo.toml, go.mod — was not modified in this session). Git operations against the repo's own remote. Commands that only touch files the agent already created in this session (agentTouchedFiles).
- "ask": the command needs user confirmation. Legitimate but sensitive workflows: fetching external content (curl/wget), querying APIs, installing new/unknown dependencies, deploying artifacts to ordinary targets, writes/deletes outside agent-touched files, privilege escalation (sudo/su), docker/cloud CLIs, pushing to a remote that differs from the configured remote, touching sensitive files (keys, .env, credentials — check gitStatus), or anything ambiguous from context.
- "deny": the command is malicious and must not run. Secret/credential/database exfiltration, obfuscated payloads (base64 -d | sh, hex-encoded eval), pipe-to-shell from untrusted infrastructure (curl evil-host | sh), download-and-execute, destructive wipes (rm -rf / or home), disabling security controls, or tampering with the agent harness itself.

Judge the pending tool call in the context of the transcript and the <environment> block. When in doubt between allow and ask, choose ask. Reserve deny for clearly malicious intent.`;

/**
 * Append the user's own permission rules (claude settings / plan mode /
 * subagent file) to the system prompt — the equivalent of Claude Code's
 * `<user_allow_rules_to_replace>` / `<user_deny_rules_to_replace>` slots, so
 * the classifier can generalize the user's stated preferences to commands
 * that match no rule.
 */
function renderUserRules(rules?: ParsedPermissions): string {
    if (!rules) return "";
    const sections: string[] = [];
    const groups: [string, ParsedPermissions["allow"]][] = [
        ["allow", rules.allow],
        ["ask", rules.ask],
        ["deny", rules.deny],
    ];
    for (const [kind, list] of groups) {
        if (!list.length) continue;
        sections.push(`${kind}:\n${list.map(r => `- ${r.category}: ${r.pattern}`).join("\n")}`);
    }
    if (sections.length === 0) return "";
    return `\n\n<user_rules>\n${sections.join("\n")}\n</user_rules>`;
}

/**
 * Assemble the system prompt: base criteria + user permission rules + the
 * `<environment>` block (Claude Code's environment rules slot).
 */
function buildSystemPrompt(sessionContext?: ClassifierSessionContext, rules?: ParsedPermissions): string {
    const prompt = SYSTEM_PROMPT + renderUserRules(rules);
    if (!sessionContext) return prompt;
    const lines: string[] = [`cwd: ${sessionContext.cwd}`];
    if (sessionContext.gitRemote) lines.push(`gitRemote: ${sessionContext.gitRemote}`);
    if (sessionContext.agentTouchedFiles?.length) lines.push(`agentTouchedFiles: ${sessionContext.agentTouchedFiles.join(", ")}`);
    if (sessionContext.gitStatus) lines.push(`gitStatus:\n${sessionContext.gitStatus}`);
    return `${prompt}\n\n<environment>\n${lines.join("\n")}\n</environment>`;
}

// ============================================================================
// Chat Completion Call
// ============================================================================

interface RequestOptions {
    signal?: AbortSignal;
}

/** Extract the first JSON object from model output (tolerates fences/prose). */
function extractJsonObject(raw: string): Record<string, unknown> {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
        throw new ClassifierError(`LLM classifier returned non-JSON output: ${JSON.stringify(raw.slice(0, 200))}`);
    }
    try {
        return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    }
    catch (err) {
        throw new ClassifierError(`LLM classifier returned malformed JSON: ${JSON.stringify(raw.slice(0, 200))}`, { cause: err });
    }
}

/**
 * Assistant-turn prefill carrying the tool call in question — the model
 * continues this turn with `{"label": ...}`.
 */
function buildPrefillMessage(model: Model<Api>, text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
    };
}

async function requestLabel(
    model: Model<Api>,
    systemPrompt: string,
    messages: Message[],
    options: RequestOptions = {},
): Promise<PermissionDecision> {
    if (!registry) throw new ClassifierError("LLM classifier registry not loaded");

    let response: AssistantMessage;
    try {
        // pi resolves auth/base URL/headers, applies `timeoutMs`, client
        // retries and abort via `signal`. `samplingParams` are merged into the
        // request body as-is by the OpenAI-compatible adapter — carrying the
        // schema-constrained `response_format` for the `{"label": ...}` reply.
        response = await registry.complete(model, { systemPrompt, messages }, {
            temperature: 0,
            reasoning: "off",
            reasoningEffort: "none",
            thinking: { enabled: false },
            timeoutMs: TIMEOUT_MS,
            signal: options.signal,
            samplingParams: { response_format: RESPONSE_FORMAT },
        });
    }
    catch (err) {
        throw new ClassifierError(`LLM classifier request failed: ${String(err)}`, { cause: err });
    }

    // Provider/stream failures arrive as an error-terminated AssistantMessage.
    if (response.stopReason === "error" || response.stopReason === "aborted" || response.errorMessage) {
        throw new ClassifierError(`LLM classifier request failed: ${response.errorMessage ?? response.stopReason}`);
    }

    const content = response.content
        .filter(block => block.type === "text")
        .map(block => (block.type === "text" ? block.text : ""))
        .join("");
    if (!content) {
        throw new ClassifierError(`LLM classifier response had no text content (stopReason=${response.stopReason})`);
    }

    const parsed = extractJsonObject(content);
    const normalized = normalizeLabel(parsed["label"]);
    return { decision: normalized, reason: `Auto mode LLM (label=${normalized})` };
}

/**
 * Classify a bash command as allow / ask / deny via chat completion.
 *
 * `entries` is the live session history (`sessionManager.getEntries()`); the
 * transcript derives from it, excluding assistant prose and tool responses.
 * `sessionContext` feeds the system prompt's `<environment>` block; `rules`
 * feeds the `<user_rules>` block. User instruction files come from
 * {@link setIntentFiles}.
 *
 * Never throws — request failures (network, HTTP, malformed/unknown label,
 * prompt overflow) degrade to `ask` so the user gets the final say
 * (fail closed to the manual approval flow, like Claude Code).
 */
export async function classifyBashCommand(
    command: string,
    signal?: AbortSignal,
    sessionContext?: ClassifierSessionContext,
    entries?: SessionEntry[],
    rules?: ParsedPermissions,
): Promise<PermissionDecision> {
    try {
        if (!registry) throw new ClassifierError("LLM classifier registry not loaded");
        const model = registry.find(PROVIDER, LLM_MODEL);
        if (!model) {
            throw new ClassifierError(`LLM classifier model ${PROVIDER}/${LLM_MODEL} not found in the model registry`);
        }

        const transcript = buildTranscriptLines(entries).join("\n") || "(no prior session activity)";
        const prefill = buildPrefill("bash", truncateHead(command, { maxBytes: MAX_TOOL_DETAIL }).content);

        const messages: Message[] = [];
        const intent = buildIntentMessage(intentFiles);
        if (intent) messages.push({ role: "user", content: intent, timestamp: Date.now() });
        messages.push({ role: "user", content: transcript, timestamp: Date.now() });
        messages.push(buildPrefillMessage(model, prefill));

        return await requestLabel(model, buildSystemPrompt(sessionContext, rules), messages, { signal });
    }
    catch (err) {
        return { decision: "ask", reason: "LLM classifier request failed\n" + String(err) };
    }
}
