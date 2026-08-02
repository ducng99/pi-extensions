/**
 * TUI rendering for the subagent tool.
 */

import { type AgentToolResult, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

import type { DisplayItem, SubagentDetails } from "./types";
import { formatToolCall, formatUsageStats, getDisplayItems, getFinalOutput, isFailedResult } from "./utils";

interface Theme {
    fg(color: string, text: string): string;
    bold(text: string): string;
}

const COLLAPSED_ITEM_COUNT = 10;

function renderDisplayItems(
    items: DisplayItem[],
    theme: Theme,
    limit?: number,
    expanded?: boolean,
): string {
    const toShow = limit ? items.slice(-limit) : items;
    const skipped = limit && items.length > limit ? items.length - limit : 0;
    let text = "";
    if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
    for (const item of toShow) {
        if (item.type === "text") {
            const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
            text += `${theme.fg("toolOutput", preview)}\n`;
        }
        else {
            text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
        }
    }
    return text.trimEnd();
}

export function renderCall(
    args: Record<string, unknown>,
    theme: Theme,
): Component {
    const agentName = (args.agent as string) || "...";
    const task = (args.task as string) || "";
    const preview = task ? (task.length > 60 ? `${task.slice(0, 60)}...` : task) : "...";
    let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", agentName);
    if (args.runInBackground) text += theme.fg("warning", " (background)");
    text += `\n  ${theme.fg("dim", preview)}`;
    return new Text(text, 0, 0);
}

export function renderResult(
    result: AgentToolResult<SubagentDetails>,
    options: { expanded: boolean },
    theme: Theme,
): Component {
    const mdTheme = getMarkdownTheme();
    const details = result.details as SubagentDetails | undefined;

    if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
    }

    if (details.mode === "background" && details.backgroundTasks && details.backgroundTasks.length > 0) {
        const bg = details.backgroundTasks;
        const icon = theme.fg("success", "✓");
        let text = `${icon} ${theme.fg("toolTitle", theme.bold("background "))}${theme.fg("accent", "started")}`;
        for (const task of bg) {
            text += `\n${theme.fg("muted", "─── ")}${theme.fg("accent", task.agent)} ${theme.fg("dim", task.backgroundId)}`;
            text += `\n${theme.fg("muted", "Output: ")}${theme.fg("dim", task.outputPath)}`;
        }
        return new Text(text, 0, 0);
    }

    if (details.mode === "single" && details.results.length === 1) {
        const r = details.results[0]!;
        const isError = isFailedResult(r);
        const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const displayItems = getDisplayItems(r.messages);
        const finalOutput = getFinalOutput(r.messages);

        if (options.expanded) {
            const container = new Container();
            let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
            if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
            container.addChild(new Text(header, 0, 0));
            if (isError && r.errorMessage) {
                container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
            }
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
            container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
            if (displayItems.length === 0 && !finalOutput) {
                container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
            }
            else {
                for (const item of displayItems) {
                    if (item.type === "toolCall") {
                        container.addChild(
                            new Text(
                                theme.fg("muted", "→ ")
                                + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                                0,
                                0,
                            ),
                        );
                    }
                }
                if (finalOutput) {
                    container.addChild(new Spacer(1));
                    container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
                }
            }
            const usageStr = formatUsageStats(r.usage, r.model);
            if (usageStr) {
                container.addChild(new Spacer(1));
                container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
            }
            return container;
        }

        let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
        if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
        if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
        else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
        else {
            text += `\n${renderDisplayItems(displayItems, theme, COLLAPSED_ITEM_COUNT, options.expanded)}`;
            if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        }
        const usageStr = formatUsageStats(r.usage, r.model);
        if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
        return new Text(text, 0, 0);
    }

    const text = result.content[0];
    return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
}
