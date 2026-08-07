/**
 * Custom TUI renderers for the plan tools.
 *
 * renderCall: compact one-line header
 * renderResult: Container with a header, spacer, and the plan content
 * (plain Text when collapsed, Markdown when expanded)
 */

import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

import type { PlanDetails } from "./schema";

/**
 * Build a MarkdownTheme from the pi Theme so Markdown rendering matches the
 * active color scheme.
 */
function buildMarkdownTheme(theme: Theme) {
    return {
        heading: (text: string) => theme.fg("mdHeading", text),
        link: (text: string) => theme.fg("mdLink", text),
        linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
        code: (text: string) => theme.fg("mdCode", text),
        codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
        codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
        quote: (text: string) => theme.fg("mdQuote", text),
        quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
        hr: (text: string) => theme.fg("mdHr", text),
        listBullet: (text: string) => theme.fg("mdListBullet", text),
        bold: (text: string) => theme.bold(text),
        italic: (text: string) => theme.italic(text),
        strikethrough: (text: string) => theme.strikethrough(text),
        underline: (text: string) => theme.underline(text),
    };
}

export function renderCall(args: Record<string, unknown>, theme: Theme) {
    const filename = typeof args.filename === "string" ? args.filename : "";
    const toolName = typeof args.new_text === "string" ? "edit_plan" : "write_plan";
    let text = theme.fg("toolTitle", theme.bold(`${toolName} `));
    text += theme.fg("dim", `${filename.replace(/\.md$/, "")}.md`);
    return new Text(text, 0, 0);
}

export function renderResult(
    result: AgentToolResult<PlanDetails>,
    options: { expanded: boolean; isPartial: boolean },
    theme: Theme,
) {
    const container = new Container();
    const filename = result.details?.filename ?? "";
    const content = result.content[0]?.type === "text" ? result.content[0].text : "";

    container.addChild(
        new Text(theme.bold("Plan ") + theme.fg("dim", filename), 0, 0),
    );
    container.addChild(new Spacer(1));

    if (options.expanded) {
        container.addChild(new Markdown(content, 1, 0, buildMarkdownTheme(theme)));
    }
    else {
        container.addChild(new Text(content, 1, 0));
    }

    return container;
}
