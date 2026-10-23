/**
 * Patch extension: registers the `patch` tool, which applies a unified diff to ONE file.
 */

import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { applyPatch } from "./apply";

const PatchParams = Type.Object({
    path: Type.String({ description: "Path to the file to patch (relative or absolute)" }),
    patch: Type.String({
        description: "Unified diff hunks to apply to the file. Each hunk starts with a '@@ -a,b +c,d @@' header, followed by lines prefixed with ' ' (context), '-' (remove) or '+' (add). '---'/'+++' file headers are optional.",
    }),
});

export default function patchExtension(pi: ExtensionAPI) {
    pi.registerTool({
        name: "patch",
        label: "Patch",
        promptSnippet: "Apply a unified diff patch to a single file",
        description: "Apply a unified diff patch to ONE existing file. Provide the file path and the diff hunks ('@@ -a,b +c,d @@' headers with ' ', '-', '+' prefixed lines). Context and removed lines must match the file. The patch is applied atomically: if any hunk fails, the file is left unchanged.",
        promptGuidelines: [
            "Use patch to apply a unified diff to one file; call it once per file",
        ],
        parameters: PatchParams,

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const abs = isAbsolute(params.path) ? params.path : resolve(ctx.cwd, params.path);
            try {
                const original = await readFile(abs, "utf8");
                const updated = applyPatch(original, params.patch);
                await writeFile(abs, updated, "utf8");
                return {
                    content: [{ type: "text" as const, text: `Successfully patched ${params.path}` }],
                    details: { path: params.path },
                };
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `Patch failed: ${message}` }],
                    details: { path: params.path },
                    isError: true,
                };
            }
        },

        renderCall(args, theme) {
            const lines = typeof args.patch === "string" ? args.patch.split("\n").length : 0;
            let text = theme.fg("muted", "patch ") + theme.fg("accent", args.path ?? "...");
            if (lines > 1) text += theme.fg("dim", ` (${lines} lines)`);
            return new Text(text, 0, 0);
        },
    });
}
