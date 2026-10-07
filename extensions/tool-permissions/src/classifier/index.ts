import type { ModelRegistry, SessionEntry } from "@earendil-works/pi-coding-agent";

import type { PermissionDecision } from "../permission-check";
import type { ParsedPermissions } from "../permission-parsing";
import type { ClassifierSessionContext } from "../session-context";
import { classifyToolCall as classifyWithClassifier, loadClassifier as loadTextClassifier } from "./classifier";
import { classifyToolCall as classifyWithSystemOne, loadClassifier as loadSystemOneClassifier } from "./systemone";

/**
 * Classifier facade: selects the classification backend.
 *
 * - `"classifier"`: legacy `/autoshell` text-classifier endpoint
 *   (`./text-classifier.ts`).
 * - `"llm"`: chat-completion LLM judge (`./llm.ts`).
 *
 * Flip the constant to switch backends. Both backends expose the same
 * `loadClassifier` / `classifyToolCall` interface; `entries` (transcript)
 * and `rules` (user permission rules) are only consumed by the LLM backend
 * and ignored by the text backend.
 */

type ClassifierBackend = "classifier" | "systemone";

const CLASSIFIER_BACKEND: ClassifierBackend = "systemone";

export async function loadClassifier(modelRegistry: ModelRegistry) {
    if (CLASSIFIER_BACKEND === "systemone") {
        return loadSystemOneClassifier(modelRegistry);
    }
    return loadTextClassifier(modelRegistry);
}

export async function classifyToolCall(
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    sessionContext?: ClassifierSessionContext,
    entries?: SessionEntry[],
    rules?: ParsedPermissions,
): Promise<PermissionDecision> {
    if (CLASSIFIER_BACKEND === "systemone") {
        return classifyWithSystemOne(toolName, input, signal, sessionContext, entries, rules);
    }
    return classifyWithClassifier(toolName, input, signal, sessionContext);
}
