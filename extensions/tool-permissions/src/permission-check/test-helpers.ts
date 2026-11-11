import { mock } from "bun:test";

import type { ParsedPermissions } from "../permission-parsing";
import type { PermissionDecision } from "./types";

/**
 * The real classifier (`../classifier`) queries a model server over the
 * network, so it is replaced with a controllable mock for every test file in
 * this directory. `mock.module` overwrites the exports of the already-loaded
 * module and permission-check's live bindings pick up the replacement.
 */
export const classifyMock = mock(
    async (toolName: string, input?: Record<string, unknown>, signal?: AbortSignal): Promise<PermissionDecision> => {
        // Fail loudly if a test triggers classification without opting in via
        // `mockImplementation` (only the mode-fallback suites opt in).
        throw new Error(`Unexpected classifier call: ${toolName}${signal ? " (with signal)" : ""}`);
    },
);

mock.module("../classifier", () => ({
    classifyToolCall: classifyMock,
}));

export function makePerms(opts: {
    allow?: { category: string; pattern: string }[];
    ask?: { category: string; pattern: string }[];
    deny?: { category: string; pattern: string }[];
}): ParsedPermissions {
    return {
        allow: (opts.allow ?? []).map(r => ({ ...r })),
        ask: (opts.ask ?? []).map(r => ({ ...r })),
        deny: (opts.deny ?? []).map(r => ({ ...r })),
    };
}
