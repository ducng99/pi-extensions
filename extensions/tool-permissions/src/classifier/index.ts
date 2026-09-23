import type { ModelRegistry, SessionEntry } from "@earendil-works/pi-coding-agent";

import type { PermissionDecision } from "../permission-check";
import type { ParsedPermissions } from "../permission-parsing";
import type { ClassifierSessionContext } from "../session-context";
import { classifyBashCommand as classifyWithLlm, loadClassifier as loadLlm } from "./llm";
import { classifyBashCommand as classifyWithText, loadClassifier as loadText } from "./text-classifier";

/**
 * Classifier facade: selects the bash-command classification backend.
 *
 * - `"text"`: legacy `/autoshell` text-classifier endpoint
 *   (`./text-classifier.ts`).
 * - `"llm"`: chat-completion LLM judge (`./llm.ts`).
 *
 * Flip the constant to switch backends. Both backends expose the same
 * `loadClassifier` / `classifyBashCommand` interface; `entries` (transcript)
 * and `rules` (user permission rules) are only consumed by the LLM backend
 * and ignored by the text backend.
 */

type ClassifierBackend = "text" | "llm";

const CLASSIFIER_BACKEND: ClassifierBackend = "text";

export async function loadClassifier(modelRegistry: ModelRegistry) {
    if (CLASSIFIER_BACKEND === "llm") {
        return loadLlm(modelRegistry);
    }
    return loadText(modelRegistry);
}

export async function classifyBashCommand(
    command: string,
    signal?: AbortSignal,
    sessionContext?: ClassifierSessionContext,
    entries?: SessionEntry[],
    rules?: ParsedPermissions,
): Promise<PermissionDecision> {
    if (CLASSIFIER_BACKEND === "llm") {
        return classifyWithLlm(command, signal, sessionContext, entries, rules);
    }
    return classifyWithText(command, signal, sessionContext);
}

export { type ContextFile, setIntentFiles as setClassifierIntentFiles } from "./llm";
export { ClassifierError } from "./types";
