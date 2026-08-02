/**
 * TUI component for the Ask User Questions tool
 *
 * Renders a tabbed interface with one tab per question + a Submit summary tab.
 * Supports single-choice (radio) and multi-choice (checkbox) per question.
 */

import {
    Key,
    matchesKey,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { InlineInput } from "../shared/tui-components/index";
import type { AskQuestionsResult, Question, QuestionResult } from "./types";

// ============================================================================
// Helpers
// ============================================================================

function addWrapped(lines: string[], text: string, width: number) {
    lines.push(...wrapTextWithAnsi(text, width));
}

function addWrappedWithPrefix(
    lines: string[],
    prefix: string,
    text: string,
    width: number,
) {
    const pw = visibleWidth(prefix);
    if (pw >= width) {
        addWrapped(lines, prefix + text, width);
        return;
    }
    const wrapped = wrapTextWithAnsi(text, width - pw);
    const cont = " ".repeat(pw);
    for (let i = 0; i < wrapped.length; i++) {
        lines.push(truncateToWidth(`${i === 0 ? prefix : cont}${wrapped[i]}`, width));
    }
}

// ============================================================================
// Component factory
// ============================================================================

export interface QuestionsComponentCallbacks {
    tui: { requestRender(): void };
    theme: {
        fg(color: string, text: string): string;
        bg(color: string, text: string): string;
        bold(text: string): string;
    };
    done: (result: AskQuestionsResult) => void;
}

export function createQuestionsComponent(
    questions: Question[],
    { tui, theme, done }: QuestionsComponentCallbacks,
) {
    const totalTabs = questions.length + 1; // questions + Submit
    const OTHER_INDEX = -1; // Special index for "Other" option

    // ── State ──────────────────────────────────────────────────
    let currentTab = 0;
    let cursorIndex = 0;
    let cachedLines: string[] | undefined;
    const selections: Set<number>[] = questions.map(() => new Set());
    const customTexts: Map<number, string> = new Map(); // questionIndex -> custom text
    let inputMode = false;
    let otherInput: InlineInput | null = null;

    // ── Internal helpers ───────────────────────────────────────

    function refresh() {
        cachedLines = undefined;
        tui.requestRender();
    }

    function clampCursor() {
        const q = questions[currentTab];
        if (!q) return;
        // +1 for the "Other" option
        cursorIndex = Math.min(cursorIndex, q.answers.length);
        cursorIndex = Math.max(0, cursorIndex);
    }

    function allAnswered(): boolean {
        return questions.every((_, i) => selections[i]!.size > 0 || customTexts.has(i));
    }

    function enterInputMode(tabIndex: number) {
        inputMode = true;
        otherInput = new InlineInput();
        const value = customTexts.get(tabIndex) || "";
        otherInput.setValue(value);
        // Move cursor to end by sending End key
        otherInput.handleInput("\x1b[F");
    }

    function buildResult(cancelled: boolean): AskQuestionsResult {
        const answers: QuestionResult[] = questions.map((q, i) => {
            const sel = Array.from(selections[i]!).sort((a, b) => a - b);
            const hasCustom = customTexts.has(i);
            return {
                questionIndex: i,
                header: q.header,
                selectedIndices: hasCustom ? [] : sel,
                selectedLabels: hasCustom ? [] : sel.map(idx => q.answers[idx]?.label ?? ""),
                customText: customTexts.get(i),
            };
        });
        return { questions, answers, cancelled };
    }

    // ── Tab bar ────────────────────────────────────────────────

    function renderTabBar(w: number): string[] {
        const lines: string[] = [];
        const tabs: string[] = [" "];

        for (let i = 0; i < questions.length; i++) {
            const isActive = i === currentTab;
            const isAnswered = selections[i]!.size > 0;
            const hdr = questions[i]!.header;
            const indicator = isAnswered ? "●" : "○";
            const color = isAnswered ? "success" : "muted";
            const text = ` ${indicator} ${hdr} `;
            const styled = isActive
                ? theme.bg("selectedBg", theme.fg("text", text))
                : theme.fg(color, text);
            tabs.push(`${styled} `);
        }

        const canSubmit = allAnswered();
        const isSubmitTab = currentTab === questions.length;
        const submitText = " ✓ Submit ";
        const submitStyled = isSubmitTab
            ? theme.bg("selectedBg", theme.fg("text", submitText))
            : theme.fg(canSubmit ? "success" : "dim", submitText);
        tabs.push(`${submitStyled}`);

        addWrappedWithPrefix(lines, "", tabs.join(""), w);
        lines.push("");
        return lines;
    }

    // ── Submit / summary tab ───────────────────────────────────

    function renderSubmitTab(w: number): string[] {
        const lines: string[] = [];

        addWrappedWithPrefix(lines, " ", theme.fg("accent", theme.bold("Review & Submit")), w);
        lines.push("");

        for (let i = 0; i < questions.length; i++) {
            const q = questions[i]!;
            const sel = selections[i]!;
            const hasCustom = customTexts.has(i);
            const answered = sel.size > 0 || hasCustom;
            const icon = answered ? theme.fg("success", "✓") : theme.fg("warning", "○");
            addWrappedWithPrefix(lines, ` ${icon} `, theme.fg("text", theme.bold(q.header)), w);

            if (hasCustom) {
                const customVal = customTexts.get(i) || "";
                addWrappedWithPrefix(lines, "   ", theme.fg("muted", `"${customVal}"`), w);
            }
            else if (answered) {
                const labels = Array.from(sel)
                    .sort((a, b) => a - b)
                    .map(idx => q.answers[idx]?.label)
                    .join(", ");
                addWrappedWithPrefix(lines, "   ", theme.fg("muted", labels), w);
            }
            else {
                addWrappedWithPrefix(lines, "   ", theme.fg("warning", "Not answered"), w);
            }
            lines.push("");
        }

        if (allAnswered()) {
            addWrappedWithPrefix(lines, " ", theme.fg("success", "Press Enter to submit"), w);
        }
        else {
            const missing = questions
                .filter((_, i) => selections[i]!.size === 0)
                .map(q => q.header)
                .join(", ");
            addWrappedWithPrefix(lines, " ", theme.fg("warning", `Unanswered: ${missing}`), w);
        }

        return lines;
    }

    // ── Question tab ───────────────────────────────────────────

    function renderQuestionTab(w: number): string[] {
        const lines: string[] = [];
        const q = questions[currentTab]!;
        const sel = selections[currentTab]!;
        const hasCustom = customTexts.has(currentTab);
        const mode = q.multipleChoice ? "Select one or more" : "Select one";

        addWrappedWithPrefix(lines, " ", theme.fg("text", theme.bold(q.question)), w);
        addWrappedWithPrefix(lines, " ", theme.fg("dim", mode), w);
        lines.push("");

        for (let i = 0; i < q.answers.length; i++) {
            const ans = q.answers[i]!;
            const isActive = i === cursorIndex;
            const isSelected = sel.has(i);

            // Checkbox or radio indicator
            let indicator: string;
            if (q.multipleChoice) {
                indicator = isSelected ? theme.fg("success", "☑") : theme.fg("muted", "☐");
            }
            else {
                indicator = isSelected ? theme.fg("success", "●") : theme.fg("muted", "○");
            }

            const cursor = isActive ? theme.fg("accent", "❯ ") : "  ";
            const labelColor = isActive ? "accent" : "text";
            const label = `${i + 1}. ${ans.label}`;

            addWrappedWithPrefix(lines, ` ${cursor}${indicator} `, theme.fg(labelColor, label), w);

            if (ans.description) {
                addWrappedWithPrefix(lines, "     ", theme.fg("muted", ans.description), w);
            }
        }

        // "Other" option
        const otherIndex = q.answers.length;
        const isOtherActive = cursorIndex === otherIndex || cursorIndex === OTHER_INDEX;
        const isOtherSelected = hasCustom;

        let otherIndicator: string;
        if (q.multipleChoice) {
            otherIndicator = isOtherSelected ? theme.fg("success", "☑") : theme.fg("muted", "☐");
        }
        else {
            otherIndicator = isOtherSelected ? theme.fg("success", "●") : theme.fg("muted", "○");
        }

        const otherCursor = isOtherActive ? theme.fg("accent", "❯ ") : "  ";
        const otherLabel = `${otherIndex + 1}. Other`;

        // Inline input for "Other" option
        if (inputMode && isOtherActive && otherInput) {
            const inputLines = otherInput.render(w - otherLabel.length - 5);
            const inputText = inputLines[0] || "";
            addWrappedWithPrefix(lines, ` ${otherCursor}${otherIndicator} `, theme.fg("accent", `${otherLabel}: ${inputText}`), w);
        }
        else if (hasCustom) {
            const customVal = customTexts.get(currentTab) || "";
            addWrappedWithPrefix(lines, ` ${otherCursor}${otherIndicator} `, theme.fg(isOtherActive ? "accent" : "text", `${otherLabel}: ${theme.fg("success", customVal)}`), w);
        }
        else {
            addWrappedWithPrefix(lines, ` ${otherCursor}${otherIndicator} `, theme.fg(isOtherActive ? "accent" : "text", otherLabel), w);
        }

        return lines;
    }

    // ── Full render ────────────────────────────────────────────

    function render(width: number): string[] {
        if (cachedLines) return cachedLines;

        const lines: string[] = [];
        const w = Math.max(1, width);

        // Top border
        lines.push(theme.fg("accent", "─".repeat(w)));

        // Tab bar
        lines.push(...renderTabBar(w));

        // Content
        if (currentTab === questions.length) {
            lines.push(...renderSubmitTab(w));
        }
        else {
            lines.push(...renderQuestionTab(w));
        }

        // Help
        lines.push("");
        let help: string;
        if (inputMode) {
            help = "←→ move cursor • ↑↓ exit input • Enter confirm • Esc cancel";
        }
        else if (questions.length > 1) {
            help = "Tab navigate tabs • ↑↓ navigate options • Space/Enter select • Esc cancel";
        }
        else {
            help = "↑↓ navigate • Space/Enter select • Esc cancel";
        }
        addWrappedWithPrefix(lines, " ", theme.fg("dim", help), w);

        // Bottom border
        lines.push(theme.fg("accent", "─".repeat(w)));

        cachedLines = lines;
        return lines;
    }

    // ── Input handling ─────────────────────────────────────────

    function handleInput(data: string): void {
        const otherIndex = questions[currentTab]?.answers.length ?? 0;

        // Input mode for "Other" text entry
        if (inputMode && otherInput) {
            if (matchesKey(data, Key.enter)) {
                const value = otherInput.getValue().trim();
                if (value.length > 0) {
                    // Confirm custom text
                    customTexts.set(currentTab, value);
                    selections[currentTab]!.delete(OTHER_INDEX);
                }
                inputMode = false;
                otherInput = null;
                // Move to next tab
                if (currentTab < questions.length - 1) {
                    currentTab++;
                }
                else {
                    currentTab = questions.length; // Submit tab
                }
                cursorIndex = 0;
                clampCursor();
                refresh();
                return;
            }
            if (matchesKey(data, Key.escape)) {
                // Cancel input mode - restore original value if editing
                const original = customTexts.get(currentTab);
                if (original) {
                    otherInput.setValue(original);
                }
                else {
                    otherInput.setValue("");
                }
                inputMode = false;
                otherInput = null;
                refresh();
                return;
            }
            // Up/Down: exit input mode and navigate options
            if (matchesKey(data, Key.up)) {
                const value = otherInput.getValue().trim();
                if (value.length > 0) {
                    customTexts.set(currentTab, value);
                }
                else {
                    customTexts.delete(currentTab);
                }
                inputMode = false;
                otherInput = null;
                cursorIndex = Math.max(0, otherIndex - 1);
                refresh();
                return;
            }
            if (matchesKey(data, Key.down)) {
                const value = otherInput.getValue().trim();
                if (value.length > 0) {
                    customTexts.set(currentTab, value);
                }
                inputMode = false;
                otherInput = null;
                refresh();
                return;
            }
            // Tab navigation while typing - confirm input if any, then navigate
            if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
                const value = otherInput.getValue().trim();
                if (value.length > 0) {
                    customTexts.set(currentTab, value);
                }
                inputMode = false;
                otherInput = null;
                if (matchesKey(data, Key.tab)) {
                    currentTab = (currentTab + 1) % totalTabs;
                }
                else {
                    currentTab = (currentTab - 1 + totalTabs) % totalTabs;
                }
                cursorIndex = 0;
                clampCursor();
                const newOtherIndex = questions[currentTab]?.answers.length ?? 0;
                if (currentTab < questions.length && cursorIndex === newOtherIndex) {
                    enterInputMode(currentTab);
                }
                refresh();
                return;
            }
            // Delegate all other input to the Input component
            otherInput.handleInput(data);
            refresh();
            return;
        }

        // Submit tab
        if (currentTab === questions.length) {
            if (matchesKey(data, Key.enter) && allAnswered()) {
                done(buildResult(false));
                return;
            }
            if (matchesKey(data, Key.escape)) {
                done(buildResult(true));
                return;
            }
            if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
                currentTab = 0;
                cursorIndex = 0;
                clampCursor();
                refresh();
                return;
            }
            if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
                currentTab = questions.length - 1;
                cursorIndex = 0;
                clampCursor();
                refresh();
                return;
            }
            return;
        }

        // Question tabs
        const q = questions[currentTab]!;

        // Tab navigation
        if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
            if (inputMode) {
                const value = otherInput?.getValue().trim() || "";
                if (value.length > 0) {
                    customTexts.set(currentTab, value);
                }
                else if (!customTexts.has(currentTab)) {
                    // No value and no saved value, just exit input mode
                }
                inputMode = false;
                otherInput = null;
            }
            currentTab = (currentTab + 1) % totalTabs;
            cursorIndex = 0;
            clampCursor();
            const newOtherIndex = questions[currentTab]?.answers.length ?? 0;
            if (currentTab < questions.length && cursorIndex === newOtherIndex && !inputMode) {
                enterInputMode(currentTab);
            }
            refresh();
            return;
        }
        if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
            if (inputMode) {
                const value = otherInput?.getValue().trim() || "";
                if (value.length > 0) {
                    customTexts.set(currentTab, value);
                }
                inputMode = false;
                otherInput = null;
            }
            currentTab = (currentTab - 1 + totalTabs) % totalTabs;
            cursorIndex = 0;
            clampCursor();
            const newOtherIndex = questions[currentTab]?.answers.length ?? 0;
            if (currentTab < questions.length && cursorIndex === newOtherIndex && !inputMode) {
                enterInputMode(currentTab);
            }
            refresh();
            return;
        }

        // Cursor navigation
        if (matchesKey(data, Key.up)) {
            const wasOnOther = cursorIndex === otherIndex;
            cursorIndex = Math.max(0, cursorIndex - 1);
            if (wasOnOther && inputMode) {
                const value = otherInput?.getValue().trim() || "";
                if (value.length > 0) {
                    customTexts.set(currentTab, value);
                }
                inputMode = false;
                otherInput = null;
            }
            refresh();
            return;
        }
        if (matchesKey(data, Key.down)) {
            const wasOnOther = cursorIndex === otherIndex;
            cursorIndex = Math.min(otherIndex, cursorIndex + 1);
            if (wasOnOther && inputMode) {
                const value = otherInput?.getValue().trim() || "";
                if (value.length > 0) {
                    customTexts.set(currentTab, value);
                }
                inputMode = false;
                otherInput = null;
            }
            if (cursorIndex === otherIndex && !inputMode) {
                enterInputMode(currentTab);
            }
            refresh();
            return;
        }

        // Toggle / Select
        if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
            const sel = selections[currentTab]!;

            // Handle "Other" option
            if (cursorIndex === otherIndex || cursorIndex === OTHER_INDEX) {
                if (q.multipleChoice) {
                    // Toggle custom text
                    if (customTexts.has(currentTab)) {
                        customTexts.delete(currentTab);
                        inputMode = false;
                        otherInput = null;
                    }
                    else {
                        enterInputMode(currentTab);
                    }
                }
                else {
                    sel.clear();
                    enterInputMode(currentTab);
                }
                refresh();
                return;
            }

            // Handle regular options
            if (q.multipleChoice) {
                // Toggle checkbox
                if (sel.has(cursorIndex)) {
                    sel.delete(cursorIndex);
                }
                else {
                    sel.add(cursorIndex);
                }
            }
            else {
                // Radio: replace selection and clear custom text
                sel.clear();
                sel.add(cursorIndex);
                customTexts.delete(currentTab);

                // Enter auto-advances to next tab for radio
                if (matchesKey(data, Key.enter)) {
                    if (currentTab < questions.length - 1) {
                        currentTab++;
                    }
                    else {
                        currentTab = questions.length; // Submit tab
                    }
                    cursorIndex = 0;
                    clampCursor();
                }
            }
            refresh();
            return;
        }

        // Cancel
        if (matchesKey(data, Key.escape)) {
            done(buildResult(true));
            return;
        }
    }

    // ── Public API ─────────────────────────────────────────────

    function invalidate() {
        cachedLines = undefined;
    }

    return { render, handleInput, invalidate };
}
