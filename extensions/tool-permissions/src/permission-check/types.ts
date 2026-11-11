import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { ClassifierSessionContext } from "../session-context";

/**
 * The outcome of a permission check.
 *
 * `decision` is the action to take. When the decision is `"ask"`, an optional
 * `reason` may explain *why* it is being asked (e.g. the bash command was too
 * complex to analyze or failed to parse).
 */
export type PermissionDecision = { decision: "allow" | "ask" | "deny"; reason?: string; notify?: string };

/** Reason shown when a bash command could not be parsed by tree-sitter. */
export const REASON_BASH_PARSE_ERROR = "Unable to parse the command";
/** Reason shown when a bash command uses complex structures we don't analyze. */
export const REASON_BASH_COMPLEX = "Command uses complex structures";
/** Reason shown when the auto mode classifier denies a tool call. */
export const REASON_AUTO_MODE_DENIED = "Tool call is denied by auto mode classifier";

/**
 * The active fallback mode for tool calls that no explicit rule resolves:
 * - `"auto"` — consult the classifier (default for unresolved "ask" decisions)
 * - `"allow"` — default to allow (out-of-bounds and sensitive-path asks still
 *   apply; they are enforced before this fallback)
 * - `"off"` — default to ask
 */
export type PermissionMode = "auto" | "allow" | "off";

/**
 * Builds the compact {@link ClassifierSessionContext} fed to the bash
 * classifier. Async because it may run `git status` once. The provider is
 * called lazily — only when a command actually reaches the classifier — so
 * non-bash tool calls and rule-resolved bash commands pay nothing.
 */
export type SessionContextProvider = () => Promise<ClassifierSessionContext>;
/** Returns the live session entries for transcript-based classifiers (LLM backend). Sync — no git work. */
export type SessionEntriesProvider = () => SessionEntry[];
