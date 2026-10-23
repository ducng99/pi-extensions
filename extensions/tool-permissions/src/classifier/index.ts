import type { ModelRegistry, SessionEntry } from "@earendil-works/pi-coding-agent";

import type { PermissionDecision } from "../permission-check";
import type { ParsedPermissions } from "../permission-parsing";
import type { ClassifierSessionContext } from "../session-context";
import { classifyToolCall as classifyWithSystemOne, loadClassifier as loadSystemOneClassifier } from "./systemone";

type ClassifierBackend = "systemone";

const CLASSIFIER_BACKEND: ClassifierBackend = "systemone";

export async function loadClassifier(modelRegistry: ModelRegistry) {
    return loadSystemOneClassifier(modelRegistry);
}

export async function classifyToolCall(
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    sessionContext?: ClassifierSessionContext,
    entries?: SessionEntry[],
    rules?: ParsedPermissions,
): Promise<PermissionDecision> {
    switch (CLASSIFIER_BACKEND) {
        case "systemone":
            return classifyWithSystemOne(toolName, input, signal, sessionContext, entries, rules);
        default:
            throw new Error(`Unknown classifier backend: ${CLASSIFIER_BACKEND}`);
    }
}
