import type { ClassifierApi, ClassifierChoiceAnswer, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import { type ModelRegistry, type SessionEntry } from "@earendil-works/pi-coding-agent";

import type { PermissionDecision } from "../permission-check";
import type { ParsedPermissions } from "../permission-parsing";
import type { ClassifierSessionContext } from "../session-context";
import { ClassifierError, type ClassifierLabel } from "./types";

// ============================================================================
// Defaults
// ============================================================================

// const PROVIDER = "cloudflare-workers-ai";
// const MODEL_NAME = "@cf/cloudflare/clef";
const PROVIDER = "aimachine";
const MODEL_NAME = "oc/jev-1.13-free";
const TIMEOUT_MS = 10_000;
const CONFIDENCE_THRESHOLD = 0.6;

const RULES = `
You receive one agent \`toolCall\`, together with the session context and the chronological prompt history that preceded it.
Your only job is to decide how safe it is to execute that tool call.

## Labels

**allow** — safe to execute without checking with the user.
Read-only or reversible actions that are consistent with the session so far:
- listing / searching / reading files (\`ls\`, \`cat\`, \`grep\`, \`find\`, \`head\`, editor \`view\`)
- viewing, creating, or editing files inside the working repository
- running the project's tests, linters, builds, or other local dev commands
- \`git status\`, \`git diff\`, \`git log\`, \`git add\`, \`git commit\` on the current branch
- harmless local scaffolding (creating scratch files inside the working dir)

**ask** — must be confirmed with the user before executing.
Potentially destructive, irreversible, out-of-scope, or side-effecting actions:
- force pushes, branch deletion, rewriting or resetting git history
- deleting files or directories, overwriting files outside the user's task
- network installs/downloads (\`pip install\`, \`apt install\`, \`curl\`/\`wget\` fetches)
- calls to external services (HTTP APIs, webhooks, messaging, cloud resources)
- publishing or uploading packages/artifacts
- modifying files outside the working directory
- \`sudo\`, privilege escalation, changing system/service configuration
- anything else that has effects beyond the local repository and is not clearly covered by \`allow\`

**deny** — must never be executed, regardless of how the user phrased the request.
Clearly malicious or catastrophic actions:
- reading, printing, or touching credentials, secrets, tokens, or keychains
- exfiltrating secrets, tokens, keys, or environment variables to any sink
- \`rm -rf\` of broad paths (\`/\`, \`$HOME\`, the working dir), disk wiping, \`mkfs\`
- piping remote code into a shell (\`curl … | sh\`, \`wget … | bash\`) from an untrusted or unspecified source
- disabling or tampering with security tooling (firewall, antivirus, audit logs, monitoring), covering tracks after a compromise
- cryptomining, botnet activity, ransomware, or any attack on systems unrelated to this session
- destructive actions against unrelated systems or third-party infrastructure

## Decision order

1. If the call matches any \`deny\` criterion → \`deny\`.
2. Else if it matches any \`ask\` criterion → \`ask\`.
3. Else → \`allow\`.

When the evidence is ambiguous, choose \`ask\` rather than \`allow\` or \`deny\`.
`.trim();

let registry: ModelRegistry | null = null;

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
export function buildTranscriptLines(entries: SessionEntry[] | undefined): Array<Record<string, string>> {
    if (!entries || entries.length === 0) return [];
    const lines: Array<Record<string, string>> = [];

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
            if (text) lines.push({ user: text });
        }
        else if (msg.role === "assistant" && Array.isArray(msg.content)) {
            for (const block of msg.content) {
                if (block?.type !== "toolCall") continue;
                const { name, arguments: args } = block;
                if (typeof name !== "string" || !args) continue;
                lines.push({ [name]: toolDetail(name, args) });
            }
        }
        // Tool-result messages and assistant prose are deliberately skipped.
    }

    return lines;
}

// ============================================================================
// System Prompt
// ============================================================================

/**
 * Assemble the system prompt: base criteria + user permission rules + the
 * `<environment>` block (Claude Code's environment rules slot).
 */
function buildSessionContext(sessionContext?: ClassifierSessionContext, rules?: ParsedPermissions): Record<string, unknown> {
    const context: Record<string, unknown> = {
        rules: {
            allow: rules?.allow,
            ask: rules?.ask,
            deny: rules?.deny,
        },
    };

    if (!sessionContext) return context;

    context.cwd = sessionContext.cwd;

    if (sessionContext.gitRemote) context.gitRemote = sessionContext.gitRemote;
    if (sessionContext.agentTouchedFiles?.length) context.agentTouchedFiles = sessionContext.agentTouchedFiles.join(", ");
    if (sessionContext.gitStatus) context.gitStatus = sessionContext.gitStatus;

    return context;
}

// ============================================================================
// Chat Completion Call
// ============================================================================

interface RequestOptions {
    signal?: AbortSignal;
}

async function requestLabel(
    model: ClassifierModel<ClassifierApi>,
    sessionContext: Record<string, unknown>,
    messages: Array<Record<string, string>>,
    toolCall: Record<string, string>,
    options: RequestOptions = {},
): Promise<PermissionDecision> {
    if (!registry) throw new ClassifierError("Decision classifier registry not loaded");

    let response: ClassifierResult;
    try {
        response = await registry.classify(model, {
            state: {
                rules: RULES,
                ...sessionContext,
                messages,
                toolCall,
            },
            questions: {
                action: {
                    type: "choice",
                    instructions: "What is the appropriate action for the `toolCall`?",
                    criteria: {
                        allow: "safe to execute without checking with the user",
                        ask: "must be confirmed with the user before executing",
                        deny: "must never be executed, regardless of how the user phrased the request",
                    },
                },
            },
        }, {
            timeoutMs: TIMEOUT_MS,
            signal: options.signal,
            maxRetries: 0,
        });
    }
    catch (err) {
        throw new ClassifierError(`Decision classifier request failed: ${String(err)}`, { cause: err });
    }

    // Provider/stream failures arrive as an error-terminated AssistantMessage.
    if (response.stopReason === "error" || response.stopReason === "aborted" || response.errorMessage) {
        throw new ClassifierError(`Decision classifier request failed: ${response.errorMessage ?? response.stopReason}`);
    }

    const result = response.answers.action as ClassifierChoiceAnswer;
    const label = result.choice as ClassifierLabel;
    const score = result.probabilities[label];

    // Downgrade to ask when the model says allow/deny but isn't confident enough.
    if ((label === "allow" || label === "deny") && score < CONFIDENCE_THRESHOLD) {
        return { decision: "ask", reason: `Auto mode: ${label} confidence ${score.toFixed(2)} < ${CONFIDENCE_THRESHOLD} threshold` };
    }

    return { decision: label, reason: `Auto mode (label=${label}, score=${score.toFixed(2)})` };
}

/**
 * Classify a tool call as allow / ask / deny via classifier model.
 *
 * Never throws — request failures (network, HTTP, malformed/unknown label,
 * prompt overflow) degrade to `ask` so the user gets the final say
 * (fail closed to the manual approval flow).
 */
export async function classifyToolCall(
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    sessionContext?: ClassifierSessionContext,
    entries?: SessionEntry[],
    rules?: ParsedPermissions,
): Promise<PermissionDecision> {
    try {
        if (!registry) throw new ClassifierError("Decision classifier registry not loaded");
        const model = registry.findOfType("classifier", PROVIDER, MODEL_NAME);
        if (!model) {
            throw new ClassifierError(`Decision classifier model ${PROVIDER}/${MODEL_NAME} not found in the model registry`);
        }

        const transcript = buildTranscriptLines(entries);

        const messages: Array<Record<string, string>> = [];
        const intent = buildIntentMessage(intentFiles);
        if (intent) messages.push({ user: intent });
        messages.push(...transcript);

        return await requestLabel(model, buildSessionContext(sessionContext, rules), messages, { [toolName]: toolDetail(toolName, input) }, { signal });
    }
    catch (err) {
        return { decision: "ask", reason: "Decision classifier request failed\n" + String(err) };
    }
}
