/**
 * Patch extension: registers the `patch` tool, which applies a unified diff to ONE file.
 */

import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { type ExtensionAPI, generateDiffString, renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { applyPatch } from "./apply";

const PatchParams = Type.Object({
    path: Type.String({ description: "Path to the file to patch (relative or absolute)" }),
    patch: Type.String({
        description: "Unified diff hunks to apply to the file. Each hunk starts with a '@@ -a,b +c,d @@' header, followed by lines prefixed with ' ' (context), '-' (remove) or '+' (add). '---'/'+++' file headers are optional.",
    }),
});

interface Preview {
    diff?: string;
    firstChangedLine?: number;
    error?: string;
}

type CallComponent = Box & {
    preview?: Preview;
    previewArgsKey?: string;
    previewPending: boolean;
    settledError: boolean;
};

function getCallComponent(state: { callComponent?: unknown }, last: unknown): CallComponent {
    if (last instanceof Box) {
        state.callComponent = last;
        return last as CallComponent;
    }
    if (state.callComponent) return state.callComponent as CallComponent;
    const c = Object.assign(new Box(1, 1, text => text), { previewPending: false, settledError: false }) as CallComponent;
    state.callComponent = c;
    return c;
}

async function computePreview(path: string, patch: string, cwd: string): Promise<Preview> {
    try {
        const abs = isAbsolute(path) ? path : resolve(cwd, path);
        const original = await readFile(abs, "utf8");
        const updated = applyPatch(original, patch);
        const { diff, firstChangedLine } = generateDiffString(original.replace(/\r\n/g, "\n"), updated.replace(/\r\n/g, "\n"));
        return { diff, firstChangedLine };
    }
    catch (err) {
        return { error: `Patch failed: ${err instanceof Error ? err.message : String(err)}` };
    }
}

function buildCall(component: CallComponent, args: { path?: string }, theme: Theme, outputPad: number): CallComponent {
    const { preview } = component;
    const bg = preview
        ? (preview.error ? "toolErrorBg" : "toolSuccessBg")
        : (component.settledError ? "toolErrorBg" : "toolPendingBg");
    component.setBgFn((text: string) => theme.bg(bg, text));
    component.setPaddingX(outputPad);
    component.clear();
    component.addChild(new Text(`${theme.fg("toolTitle", theme.bold("patch"))} ${theme.fg("accent", args?.path ?? "...")}`, 0, 0));
    if (preview) {
        component.addChild(new Spacer(1));
        component.addChild(new Text(preview.error ? theme.fg("error", preview.error) : renderDiff(preview.diff ?? "", { filePath: args?.path }), 0, 0));
    }
    return component;
}

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
        renderShell: "self",

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const abs = isAbsolute(params.path) ? params.path : resolve(ctx.cwd, params.path);
            try {
                const original = await readFile(abs, "utf8");
                const updated = applyPatch(original, params.patch);
                await writeFile(abs, updated, "utf8");
                const { diff, firstChangedLine } = generateDiffString(
                    original.replace(/\r\n/g, "\n"),
                    updated.replace(/\r\n/g, "\n"),
                );
                return {
                    content: [{ type: "text" as const, text: `Successfully patched ${params.path}` }],
                    details: { path: params.path, diff, firstChangedLine },
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

        renderCall(args, theme, context) {
            const component = getCallComponent(context.state, context.lastComponent);
            const argsKey = typeof args?.path === "string" && typeof args?.patch === "string"
                ? JSON.stringify({ path: args.path, patch: args.patch })
                : undefined;
            if (component.previewArgsKey !== argsKey) {
                component.preview = undefined;
                component.previewArgsKey = argsKey;
                component.previewPending = false;
                component.settledError = false;
            }
            if (context.argsComplete && argsKey && !component.preview && !component.previewPending) {
                component.previewPending = true;
                void computePreview(args.path, args.patch, context.cwd).then((preview) => {
                    if (component.previewArgsKey === argsKey) {
                        component.preview = preview;
                        component.previewPending = false;
                        context.invalidate();
                    }
                });
            }
            return buildCall(component, args, theme, context.outputPad);
        },

        renderResult(result, _options, theme, context) {
            const callComponent = context.state.callComponent as CallComponent | undefined;
            const details = result.details as { diff?: string; firstChangedLine?: number } | undefined;
            if (callComponent) {
                let changed = false;
                if (!context.isError && typeof details?.diff === "string" && callComponent.preview?.diff !== details.diff) {
                    callComponent.preview = { diff: details.diff, firstChangedLine: details.firstChangedLine };
                    changed = true;
                }
                if (callComponent.settledError !== context.isError) {
                    callComponent.settledError = context.isError;
                    changed = true;
                }
                if (changed) buildCall(callComponent, context.args, theme, context.outputPad);
            }

            const container = context.lastComponent instanceof Container ? context.lastComponent : new Container();
            container.clear();
            if (context.isError) {
                const msg = result.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
                if (msg && msg !== callComponent?.preview?.error) {
                    container.addChild(new Spacer(1));
                    container.addChild(new Text(theme.fg("error", msg), context.outputPad, 0));
                }
            }
            return container;
        },
    });
}
