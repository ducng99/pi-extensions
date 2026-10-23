/**
 * Patch extension: registers the `patch` tool, which applies unified diffs to one or more files.
 */

import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { type ExtensionAPI, generateDiffString, renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { applyPatch } from "./apply";

const PatchParams = Type.Object({
    files: Type.Array(
        Type.Object({
            path: Type.String({ description: "Path to the file to patch (relative or absolute)" }),
            patch: Type.String({
                description: "Unified diff hunks to apply to the file. Each hunk starts with a '@@ -a,b +c,d @@' header, followed by lines prefixed with ' ' (context), '-' (remove) or '+' (add). '---'/'+++' file headers are optional.",
            }),
        }),
        { minItems: 1, description: "Files to patch, each with its own path and patch" },
    ),
});

interface FilePreview {
    path: string;
    diff?: string;
    firstChangedLine?: number;
    error?: string;
}

interface Preview {
    files: FilePreview[];
    error?: string;
}

interface FileEntry { path: string; patch: string }

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

async function patchOne(entry: FileEntry, cwd: string) {
    const abs = isAbsolute(entry.path) ? entry.path : resolve(cwd, entry.path);
    const original = await readFile(abs, "utf8");
    const updated = applyPatch(original, entry.patch);
    const { diff, firstChangedLine } = generateDiffString(original.replace(/\r\n/g, "\n"), updated.replace(/\r\n/g, "\n"));
    return { abs, updated, diff, firstChangedLine };
}

async function computePreview(files: FileEntry[], cwd: string): Promise<Preview> {
    const out: FilePreview[] = [];
    for (const entry of files) {
        try {
            const { diff, firstChangedLine } = await patchOne(entry, cwd);
            out.push({ path: entry.path, diff, firstChangedLine });
        }
        catch (err) {
            out.push({ path: entry.path, error: `Patch failed: ${err instanceof Error ? err.message : String(err)}` });
        }
    }
    return { files: out, error: out.some(f => f.error) ? "error" : undefined };
}

function getFiles(args: { files?: unknown } | undefined): FileEntry[] | undefined {
    if (!Array.isArray(args?.files)) return undefined;
    const files = args.files as { path?: unknown; patch?: unknown }[];
    if (!files.every(f => typeof f?.path === "string" && typeof f?.patch === "string")) return undefined;
    return files as FileEntry[];
}

function buildCall(component: CallComponent, args: { files?: { path?: string }[] }, theme: Theme, outputPad: number): CallComponent {
    const { preview } = component;
    const bg = preview
        ? (preview.error ? "toolErrorBg" : "toolSuccessBg")
        : (component.settledError ? "toolErrorBg" : "toolPendingBg");
    component.setBgFn((text: string) => theme.bg(bg, text));
    component.setPaddingX(outputPad);
    component.clear();
    const paths = Array.isArray(args?.files) ? args.files.map(f => f?.path ?? "...") : [];
    const title = paths.length ? paths.join(", ") : "...";
    component.addChild(new Text(`${theme.fg("toolTitle", theme.bold("patch"))} ${theme.fg("accent", title)}`, 0, 0));
    if (preview) {
        for (const f of preview.files) {
            component.addChild(new Spacer(1));
            if (preview.files.length > 1) component.addChild(new Text(theme.fg("accent", f.path), 0, 0));
            component.addChild(new Text(f.error ? theme.fg("error", f.error) : renderDiff(f.diff ?? "", { filePath: f.path }), 0, 0));
        }
    }
    return component;
}

export default function patchExtension(pi: ExtensionAPI) {
    pi.registerTool({
        name: "patch",
        label: "Patch",
        promptSnippet: "Apply unified diff patches to one or more files",
        description: "Apply unified diff patches to one or more existing files. Provide `files`, an array of { path, patch } objects; each patch holds diff hunks ('@@ -a,b +c,d @@' headers with ' ', '-', '+' prefixed lines). Context and removed lines must match the file. The call is atomic: if any hunk in any file fails, no file is changed.",
        promptGuidelines: [
            "Use patch to apply unified diffs; pass every file you need to change in one call via the `files` array",
        ],
        parameters: PatchParams,
        renderShell: "self",

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const paths = params.files.map(f => f.path);
            try {
                // Compute every result first so a failure leaves all files untouched.
                const results: (Awaited<ReturnType<typeof patchOne>> & { path: string })[] = [];
                for (const entry of params.files) {
                    try {
                        results.push({ path: entry.path, ...await patchOne(entry, ctx.cwd) });
                    }
                    catch (err) {
                        throw new Error(`${entry.path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
                    }
                }
                for (const r of results) await writeFile(r.abs, r.updated, "utf8");
                return {
                    content: [{ type: "text" as const, text: `Successfully patched ${paths.join(", ")}` }],
                    details: { files: results.map(r => ({ path: r.path, diff: r.diff, firstChangedLine: r.firstChangedLine })) },
                };
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `Patch failed (no files were changed): ${message}` }],
                    details: { files: paths.map(path => ({ path })) },
                    isError: true,
                };
            }
        },

        renderCall(args, theme, context) {
            const component = getCallComponent(context.state, context.lastComponent);
            const files = getFiles(args);
            const argsKey = files ? JSON.stringify(files) : undefined;
            if (component.previewArgsKey !== argsKey) {
                component.preview = undefined;
                component.previewArgsKey = argsKey;
                component.previewPending = false;
                component.settledError = false;
            }
            if (context.argsComplete && files && argsKey && !component.preview && !component.previewPending) {
                component.previewPending = true;
                void computePreview(files, context.cwd).then((preview) => {
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
            const details = result.details as { files?: FilePreview[] } | undefined;
            if (callComponent) {
                let changed = false;
                if (!context.isError && details?.files && JSON.stringify(callComponent.preview?.files) !== JSON.stringify(details.files)) {
                    callComponent.preview = { files: details.files };
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
                if (msg && !callComponent?.preview?.files.some(f => f.error && msg.includes(f.error))) {
                    container.addChild(new Spacer(1));
                    container.addChild(new Text(theme.fg("error", msg), context.outputPad, 0));
                }
            }
            return container;
        },
    });
}
