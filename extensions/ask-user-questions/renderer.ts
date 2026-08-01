/**
 * Custom TUI renderers for the Ask User Questions tool
 *
 * renderCall: shows question count and headers
 * renderResult: shows selected answers or cancellation status
 */

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { AskQuestionsResult, Question } from "./types";

interface Theme {
    fg(color: string, text: string): string;
    bold(text: string): string;
}

export function renderCall(
    args: Record<string, unknown>,
    theme: Theme,
) {
    const qs = (args.questions as Question[]) || [];
    const count = qs.length;
    const labels = qs.map(q => q.header).join(", ");
    let text = theme.fg("toolTitle", theme.bold("ask_user_questions "));
    text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
    if (labels) {
        text += theme.fg("dim", ` (${labels})`);
    }
    return new Text(text, 0, 0);
}

export function renderResult(
    result: AgentToolResult<AskQuestionsResult | undefined>,
    theme: Theme,
) {
    const details = result.details;
    if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
    }
    if (details.cancelled) {
        return new Text(theme.fg("warning", "Cancelled"), 0, 0);
    }
    const lines = details.answers.map((a) => {
        const q = details.questions[a.questionIndex];
        if (!q) return "";
        const icon = theme.fg("success", "✓");
        const header = theme.fg("accent", q.header);
        if (a.customText) {
            return `${icon} ${header}: ${theme.fg("text", `"${a.customText}"`)}`;
        }
        if (a.selectedLabels.length === 0) {
            return `${icon} ${header}: ${theme.fg("muted", "(no answer)")}`;
        }
        const labels = a.selectedLabels.map(l => theme.fg("text", l)).join(", ");
        return `${icon} ${header}: ${labels}`;
    });
    return new Text(lines.join("\n"), 0, 0);
}
