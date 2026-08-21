/**
 * Plan prompt component.
 *
 * The plan tools use pi's default tool-row rendering. When a plan is written
 * or edited, the tool_result handler shows a "what next?" prompt whose default
 * rendering would not be visible yet at that stage — the chat row only gets
 * its result drawn after the handler completes. So instead of relying on the
 * tool row, the handler renders this component: the plan content (Markdown,
 * scrollable) above a select list of next-step options.
 *
 * The component lives only while the prompt is open — closing it via done()
 * removes it from the UI entirely. After answering, the plan stays readable in
 * the chat via the tool's default result rendering.
 *
 * Scrolling: the plan preview occupies a fixed viewport sized from the
 * terminal height (the same approach pi's own Editor uses). The rendered
 * component always claims exactly chrome + viewport lines, so the select list
 * underneath never gets pushed out of view. PgUp/PgDn (or Ctrl+U / Ctrl+D /
 * Home / End) scroll the plan; ↑/↓ navigate the select list. In fullscreen
 * mode pi's TuiAltScreen viewport consumes PgUp/PgDn/Home/End to scroll the
 * chat before focused components see them, so Ctrl+U/Ctrl+D are the reliable
 * scroll keys there.
 *
 * Layout: shown via `ui.custom(factory, { overlay: true })` as a fullscreen
 * overlay — chrome + viewport lines fill the terminal exactly.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { Container, Markdown, matchesKey, SelectList, Spacer, Text } from "@earendil-works/pi-tui";

/**
 * Theme refinement: tweak Markdown rendering so it matches the active color
 * scheme instead of using pi's default markdown styling.
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

/** Fixed lines around the scrollable plan region. */
// header, spacer, blank after the plan, title, spacer, border, 3 options,
// border, spacer, help
const CHROME_LINES = 12;

const PLAN_OPTIONS: SelectItem[] = [
    {
        value: "Implement now — exit plan mode and continue working",
        label: "Implement now",
        description: "Exit plan mode and continue working",
    },
    {
        value: "Clear & implement — start fresh (not yet implemented)",
        label: "Clear & implement",
        description: "Start fresh (not yet implemented)",
    },
    {
        value: "Chat more — stay in plan mode and keep chatting",
        label: "Chat more",
        description: "Stay in plan mode and keep chatting",
    },
];

export interface PlanPromptCallbacks {
    tui: { requestRender(): void; terminal?: { rows?: number } };
    theme: Theme;
    /** True when the underlying tool result was an error (rendered as plain text). */
    isError?: boolean;
    done: (choice: string) => void;
}

/**
 * Build the "plan ready — what next?" component: the plan preview on top, the
 * next-step options as a SelectList below.
 */
export function createPlanPrompt(
    filename: string,
    content: string,
    { tui, theme, isError, done }: PlanPromptCallbacks,
) {
    const rows = tui.terminal?.rows ?? 24;
    // Viewport for the plan preview: the overlay covers the whole terminal, so
    // chrome + viewport = rows, filling the screen exactly.
    const planViewport = Math.max(4, rows - CHROME_LINES);

    const selectList = new SelectList(PLAN_OPTIONS, PLAN_OPTIONS.length, {
        selectedPrefix: text => theme.fg("accent", text),
        selectedText: text => theme.fg("accent", text),
        description: text => theme.fg("muted", text),
        scrollInfo: text => theme.fg("dim", text),
        noMatch: text => theme.fg("warning", text),
    });
    selectList.onSelect = item => done(item.value);
    // Esc / Ctrl+C: same behaviour as "Chat more" — keep plan mode, end the turn.
    selectList.onCancel = () => done("Chat more — stay in plan mode and keep chatting");

    const markdown = new Markdown(content, 1, 0, buildMarkdownTheme(theme));

    // ── Scroll state ───────────────────────────────────────────
    let currentWidth = 0;
    let planLines: string[] = [];
    let maxScrollTop = 0;
    let scrollTop = 0;

    /** SGR mouse wheel sequence, e.g. `\x1b[<64;12;5M` (64 = wheel up, 65 = wheel down). */
    const ESC = String.fromCharCode(27);
    const SGR_WHEEL = new RegExp(`^${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])$`);

    /** Parse an SGR mouse-wheel sequence; returns the scroll direction or null. */
    function parseWheel(data: string): number | null {
        const match = SGR_WHEEL.exec(data);
        if (match) {
            const button = Number.parseInt(match[1]!, 10);
            if ((button & 64) === 0) return null;
            const direction = button & 3;
            if (direction === 0) return -1;
            if (direction === 1) return 1;
            return null;
        }
        // Legacy X10 wheel sequences: `\x1b[M` + button (64 = up, 65 = down).
        if (data.length === 6 && data.startsWith("\x1b[M")) {
            const button = data.charCodeAt(3) - 32;
            if ((button & 64) === 0) return null;
            const direction = button & 3;
            if (direction === 0) return -1;
            if (direction === 1) return 1;
        }
        return null;
    }

    function scrollIndicator(direction: "up" | "down", hidden: number): string {
        const body = `... ${direction === "up" ? "↑" : "↓"} ${hidden} more `;
        return " " + theme.fg("dim", body);
    }

    /** Exactly planViewport lines — the scrollable plan region. */
    function renderPlanRegion(width: number): string[] {
        const w = Math.max(1, Math.floor(width));
        if (w !== currentWidth) {
            currentWidth = w;
            planLines = isError || !content
                ? [theme.fg(isError ? "error" : "warning", content || "(plan content unavailable)")]
                : markdown.render(w);
            maxScrollTop = Math.max(0, planLines.length - planViewport);
            scrollTop = Math.min(scrollTop, maxScrollTop);
        }

        const above = scrollTop;
        const below = Math.max(0, planLines.length - (scrollTop + planViewport));
        const showTop = above > 0;
        const showBottom = below > 0;
        const contentSlots = planViewport - (showTop ? 1 : 0) - (showBottom ? 1 : 0);
        const contentStart = scrollTop + (showTop ? 1 : 0);

        const region: string[] = [];
        if (showTop) region.push(scrollIndicator("up", above));
        for (const line of planLines.slice(contentStart, contentStart + contentSlots)) {
            region.push(line);
        }
        // Keep the region height stable: fill empty slots and end with the
        // "more below" indicator so the select list never moves around.
        while (region.length < planViewport - (showBottom ? 1 : 0)) region.push(" ");
        if (showBottom) region.push(scrollIndicator("down", below));
        return region;
    }

    const container = new Container();
    container.addChild(new Text(theme.bold("Plan ") + theme.fg("dim", filename || "plan.md"), 1, 0));
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("accent", theme.bold("Plan ready — what next?")), 1, 0));
    container.addChild(new Spacer(1));
    container.addChild(selectList);
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", "↑↓ choose • pgup/pgdn or ctrl+u/ctrl+d scroll plan • enter select • esc cancel"), 1, 0));

    return {
        render: (width: number) => {
            const fixed = container.render(width);
            const region = renderPlanRegion(width);
            // pi's border style around the options: a full-width line above and
            // below the select list (like the DynamicBorder in pi's own
            // selectors).
            const border = theme.fg("border", "─".repeat(Math.max(1, Math.floor(width))));
            // header + its spacer first, then the scroll region, then a blank
            // line, then title + spacer, border, options, border, spacer, help.
            return [
                ...fixed.slice(0, 2),
                ...region,
                border,
                ...fixed.slice(2),
                border,
            ];
        },
        invalidate: () => {
            currentWidth = 0;
            container.invalidate();
        },
        handleInput: (data: string) => {
            // Wheel scrolling (only delivered while shown as a focused overlay).
            const wheelDelta = parseWheel(data);
            if (wheelDelta !== null) {
                scrollTop = Math.max(0, Math.min(maxScrollTop, scrollTop + wheelDelta * 3));
                tui.requestRender();
                return;
            }

            const step = Math.max(3, Math.floor(planViewport / 2));
            // PgUp/PgDn only reach us in non-fullscreen mode — in fullscreen
            // pi's TuiAltScreen viewport consumes them to scroll the chat
            // transcript before focused components see them. Ctrl+U/Ctrl+D are
            // not bound in the alt-screen keymap, so they work in both modes.
            if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
                scrollTop = Math.max(0, scrollTop - step);
            }
            else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) {
                scrollTop = Math.min(maxScrollTop, scrollTop + step);
            }
            else if (matchesKey(data, "home")) {
                scrollTop = 0;
            }
            else if (matchesKey(data, "end")) {
                scrollTop = maxScrollTop;
            }
            else {
                selectList.handleInput(data);
            }
            tui.requestRender();
        },
    };
}
