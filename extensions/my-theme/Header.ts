import { DefaultResourceLoader, type Extension, type ExtensionContext, getAgentDir, type ReadonlyFooterDataProvider, type Skill, type SourceInfo, type Theme, VERSION } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { relative } from "path";

import type { McpServersStatus } from "../shared/utils/types";

export function createHeader(
    ctx: ExtensionContext,
    theme: Theme,
    getFooterData: () => ReadonlyFooterDataProvider | null,
    getMcpData: () => McpServersStatus[],
): Component {
    let skills: Skill[] = [];
    let extensions: Extension[] = [];

    const loadResources = async () => {
        const loader = new DefaultResourceLoader({
            cwd: ctx.cwd,
            agentDir: getAgentDir(),
        });
        await loader.reload();

        skills = loader.getSkills().skills;
        extensions = loader.getExtensions().extensions;
    };
    loadResources();

    return {
        render(width: number): string[] {
            const mcpServersStatus = getMcpData();

            const lines = [
                "",
                `${theme.bold("Pi")} ${theme.fg("muted", "v" + VERSION)}`,
                currentPath(ctx.cwd, theme, getFooterData),
            ];

            if (ctx.ui.getToolsExpanded()) {
                const skillsLines = wrapTextWithAnsi(skills.map(s => s.name).join(", "), width - 11 - 8);
                const extensionsLines = wrapTextWithAnsi(extensions.filter(e => !e.hidden).map(compactExtensionLabel).join(", "), width - 11 - 12);
                const mcpServersLines = wrapTextWithAnsi(mcpServersStatus.map(m => `${m.name} (${m.type})`).join(", "), width - 11 - 5);

                lines.push(theme.fg("dim", "Skills: " + (skillsLines[0] || "none")));
                lines.push(...skillsLines.slice(1).map(line => theme.fg("dim", line)));
                lines.push(theme.fg("dim", "Extensions: " + (extensionsLines[0] || "none")));
                lines.push(...extensionsLines.slice(1).map(line => theme.fg("dim", line)));
                lines.push(theme.fg("dim", "MCP: " + (mcpServersLines[0] || "none")));
                lines.push(...mcpServersLines.slice(1).map(line => theme.fg("dim", line)));
            }
            else {
                const mcpConnected = mcpServersStatus.filter(m => m.connected).length;
                lines.push(theme.fg("dim", `Skills: ${skills.length} · Extensions: ${extensions.length} · MCP: ${mcpConnected}/${mcpServersStatus.length}`));
            }

            for (let i = 0; i < Math.max(5, lines.length); i++) {
                if (i < lines.length) {
                    lines[i] = truncateToWidth(getLogo(i) + lines[i], width);
                }
                else {
                    lines.push(truncateToWidth(getLogo(i), width));
                }
            }

            return lines;
        },

        invalidate() {
            loadResources();
        },
    };
}

function getLogo(line: number) {
    if (line < 0 || line >= 5) return " ".repeat(11);
    return [
        "           ",
        " ██████    ",
        " ██  ██    ",
        " ████  ██  ",
        " ██    ██  ",
    ][line];
}

/**
 * Replicate the compact extension label pi prints at verbose startup,
 * e.g. `ducng99/pi-extensions:my-theme` or `mcp/src`.
 */
function isPackageSource(sourceInfo: SourceInfo): boolean {
    const source = sourceInfo?.source ?? "";
    return source.startsWith("npm:") || source.startsWith("git:");
}

function packageSourceLabel(sourceInfo: SourceInfo): string | undefined {
    const source = sourceInfo?.source ?? "";
    if (source.startsWith("npm:")) {
        return source.slice("npm:".length) || undefined;
    }
    if (source.startsWith("git:")) {
        const url = source.slice("git:".length).trim();
        // Strip an optional @ref suffix (e.g. @v1.0.0 / @<sha>).
        const withoutRef = url.replace(/@[^/@]*$/, "");
        // "github.com/owner/repo" -> "owner/repo" (drop the host).
        const slash = withoutRef.indexOf("/");
        return slash < 0 ? undefined : withoutRef.slice(slash + 1) || undefined;
    }
    return undefined;
}

function shortExtensionPath(extensionPath: string, baseDir: string | undefined): string {
    if (baseDir) {
        const rel = relative(baseDir, extensionPath).replace(/\\/g, "/");
        if (rel && rel !== "." && !rel.startsWith("..")) {
            return rel;
        }
    }
    return extensionPath.replace(/\\/g, "/");
}

function compactParts(segments: string[]): string {
    const parts = segments.slice();
    const last = parts[parts.length - 1] ?? "";
    if (last === "index.ts" || last === "index.js" || last === "index") {
        parts.pop();
    }
    else {
        parts[parts.length - 1] = last.replace(/\.(ts|js)$/, "");
    }
    return parts.filter(segment => segment.length > 0).join("/");
}

function compactExtensionLabel(extension: Extension): string {
    const sourceInfo = extension.sourceInfo;
    const segments = shortExtensionPath(extension.path, sourceInfo.baseDir).split("/").filter(segment => segment.length > 0);
    let relSegments = segments;
    if (relSegments[0] === "extensions") {
        relSegments = relSegments.slice(1);
    }
    if (isPackageSource(sourceInfo)) {
        const sourceLabel = packageSourceLabel(sourceInfo);
        if (sourceLabel) {
            const subPath = compactParts(relSegments);
            return subPath ? `${sourceLabel}:${subPath}` : sourceLabel;
        }
    }
    return compactParts(relSegments) || extension.path;
}

function currentPath(cwd: string, theme: Theme, getFooterData: () => ReadonlyFooterDataProvider | null): string {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home && cwd.startsWith(home)) {
        cwd = "~" + cwd.slice(home.length);
    }
    const branch = getFooterData()?.getGitBranch();
    if (branch) cwd += ` (${branch})`;

    return theme.fg("dim", cwd);
}
