import { DynamicBorder, keyHint, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Input, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// ============================================================================
// Custom Permission Selector Component
// ============================================================================

export interface PermissionResult {
    allow: boolean;
    /** When true, the caller should remember this approval for the rest of the
     * session and skip the prompt for subsequent matching tool calls. */
    allowSession?: boolean;
    message?: string;
}

/** Behavior of a single selector option. */
export type PermissionSelectorOptionKind = "allow" | "deny" | "denyWithMessage" | "allowSession";

export interface PermissionSelectorOption {
    label: string;
    kind: PermissionSelectorOptionKind;
}

/** Input without the "> " prompt */
export class InlineInput extends Input {
    override render(width: number): string[] {
        const lines = super.render(width);
        // Strip the hardcoded "> " prompt (first 2 chars)
        if (lines.length > 0 && lines[0]!.startsWith("> ")) {
            lines[0] = lines[0]!.slice(2);
        }
        return lines;
    }
}

/** Inline "No, " prefix + input field (no prompt) */
class NoInputInline extends Container {
    private input: InlineInput;
    private prefix = "";

    constructor() {
        super();
        this.input = new InlineInput();
        this.addChild(this.input);
    }

    setPrefix(prefix: string) {
        this.prefix = prefix;
    }

    getValue(): string {
        return this.input.getValue();
    }

    setValue(v: string) {
        this.input.setValue(v);
    }

    get focused() {
        return this.input.focused;
    }

    set focused(v: boolean) {
        this.input.focused = v;
    }

    handleInput(data: string) {
        this.input.handleInput(data);
    }

    override render(width: number): string[] {
        const lines = this.input.render(width - this.prefix.length);
        if (lines.length > 0) {
            lines[0] = truncateToWidth(this.prefix + lines[0], width);
        }
        return lines;
    }
}

export interface PermissionSelectorOptions {
    /** Max height (lines) of the scrollable title window. Defaults to 10. */
    maxTitleLines?: number;
    /** Terminal height in rows; bounds the window so the options stay visible. Defaults to 24. */
    terminalRows?: number;
    /** Options shown to the user. Defaults to Yes/No (the No option supports
     * inline deny-with-message via Tab). Pass a custom list (e.g. to add an
     * "allow for the session" option between Yes and No). */
    options?: PermissionSelectorOption[];
}

/** Default options: classic Yes/No. The No option also opens an inline input
 * (via Tab) so the user can attach a deny reason. */
const DEFAULT_OPTIONS: PermissionSelectorOption[] = [
    { label: "Yes", kind: "allow" },
    { label: "No", kind: "denyWithMessage" },
];

/** Fixed chrome lines (excluding the options themselves): borders, spacers,
 * question, scroll hint, and hints. The per-instance option count is added
 * separately when sizing the title window. */
const FIXED_PANEL_LINES = 9;
/** Rows reserved for overlay margins and the scroll hint line. */
const RESERVED_ROWS = 3;

/** SGR mouse wheel sequence, e.g. `\x1b[<64;12;5M` (64 = wheel up, 65 = wheel down). */
const ESC = String.fromCharCode(27);
const SGR_WHEEL = new RegExp(`^${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])$`);

/**
 * Permission confirmation panel: a title (the command/message, scrollable when
 * too long), the question, the Yes/No options, and key hints.
 *
 * The panel is rendered flat (custom components are layout leaves), so the
 * title window is scrolled manually. Wheel events, PageUp/PageDown and
 * Home/End only reach the component when it is shown as a focused overlay —
 * render it with `ui.custom(..., { overlay: true })`.
 */
export class PermissionSelector extends Container {
    private selectedIndex = 0;
    private options: PermissionSelectorOption[];
    private mode: "select" | "input" = "select";
    private noInput: NoInputInline;
    private title: string;
    private question: string;
    private done: (result: PermissionResult) => void;
    private readonly maxTitleLines: number;
    private readonly terminalRows: number;
    private readonly border = new DynamicBorder();

    /** Scroll offset (lines) into the wrapped title. */
    private titleScrollTop = 0;
    /** Title window height used by the last render. */
    private windowHeight = 1;
    private wrappedTitle: string[] = [];
    private wrappedTitleWidth = 0;

    constructor(title: string, question: string, done: (result: PermissionResult) => void, options?: PermissionSelectorOptions) {
        super();
        this.done = done;
        this.title = title;
        this.question = question;
        this.maxTitleLines = Math.max(1, options?.maxTitleLines ?? 10);
        this.terminalRows = Math.max(12, options?.terminalRows ?? 24);
        this.noInput = new NoInputInline();
        const opts = options?.options ?? DEFAULT_OPTIONS;
        // `PermissionSelectorOption[]` is frozen per-instance to prevent
        // accidental mid-render mutation; the caller is free to reuse the same
        // options object across multiple selectors.
        this.options = opts.map(o => ({ label: o.label, kind: o.kind }));
    }

    /** Wrapped title lines, cached per render width. */
    private getWrappedTitle(width: number): string[] {
        if (this.wrappedTitleWidth !== width) {
            this.wrappedTitleWidth = width;
            this.wrappedTitle = wrapTextWithAnsi(this.title, Math.max(1, width - 4));
        }
        return this.wrappedTitle;
    }

    /** The selected option, if any (undefined only when the options list is empty). */
    private getSelectedOption(): PermissionSelectorOption | undefined {
        return this.options[this.selectedIndex];
    }

    /** True when the selected option supports entering input mode via Tab. */
    private get canEnterInputMode(): boolean {
        return this.getSelectedOption()?.kind === "denyWithMessage";
    }

    private getHints(): string {
        if (this.mode === "input") {
            return `${keyHint("tui.select.confirm", "submit")}  ${keyHint("tui.select.cancel", "back")}`;
        }
        const parts: string[] = [
            `${rawKeyHint("↑↓", "navigate")}`,
            `${keyHint("tui.select.confirm", "select")}`,
            `${keyHint("tui.select.cancel", "cancel")}`,
        ];
        if (this.canEnterInputMode) {
            parts.push(`${rawKeyHint("Tab", "deny with message")}`);
        }
        return parts.join("  ");
    }

    override render(width: number): string[] {
        const w = Math.max(1, Math.floor(width));
        const wrapped = this.getWrappedTitle(w);

        // Window height: leave room for the fixed chrome (which grows with
        // the option count), the scroll hint and the overlay margins so the
        // options are always visible.
        const chrome = FIXED_PANEL_LINES + this.options.length;
        const budget = Math.max(1, this.terminalRows - chrome - RESERVED_ROWS);
        this.windowHeight = Math.min(wrapped.length, Math.min(this.maxTitleLines, budget));
        this.titleScrollTop = Math.min(this.titleScrollTop, Math.max(0, wrapped.length - this.windowHeight));

        const lines: string[] = [];
        lines.push(this.border.render(w)[0] ?? "");
        lines.push("");

        // Scrollable title window.
        for (let i = 0; i < this.windowHeight; i++) {
            const src = wrapped[this.titleScrollTop + i];
            const content = src === undefined ? "" : truncateToWidth(src, w - 4);
            lines.push(`  ${content}  `);
        }

        // Scroll hint when the window hides part of the title.
        if (wrapped.length > this.windowHeight) {
            const below = wrapped.length - (this.titleScrollTop + this.windowHeight);
            const parts: string[] = [];
            if (this.titleScrollTop > 0) parts.push(`${this.titleScrollTop} above`);
            if (below > 0) parts.push(`${below} below`);
            lines.push(`  ${rawKeyHint("wheel/PgUp/PgDn", `scroll · ${parts.join(" · ")}`)}  `);
        }

        lines.push("");
        lines.push(`  ${this.question}  `);
        lines.push("");

        for (let i = 0; i < this.options.length; i++) {
            const isSelected = i === this.selectedIndex;
            const label = isSelected ? "→ " : "  ";
            const opt = this.options[i]!;

            // The inline input for the deny-with-message input mode is
            // attached to the option with kind `denyWithMessage`. Using `kind`
            // (rather than the legacy index-based check) means the prefix
            // label stays accurate regardless of how many options precede it.
            if (isSelected && this.mode === "input" && opt.kind === "denyWithMessage") {
                this.noInput.setPrefix(`  ${label}${opt.label}, `);
                lines.push(...this.noInput.render(w - 2).map(line => line + "  "));
            }
            else {
                lines.push(`  ${label}${opt.label}  `);
            }
        }

        lines.push("");
        lines.push(` ${this.getHints()} `);
        lines.push("");
        lines.push(this.border.render(w)[0] ?? "");
        return lines;
    }

    /** Scroll the title window by `delta` lines; clamps and re-renders. */
    private scrollTitle(delta: number) {
        const max = Math.max(0, this.wrappedTitle.length - this.windowHeight);
        const next = Math.max(0, Math.min(max, this.titleScrollTop + delta));
        if (next !== this.titleScrollTop) {
            this.titleScrollTop = next;
        }
    }

    /** Parse an SGR mouse-wheel sequence; returns the scroll direction or null. */
    private parseWheel(data: string): number | null {
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

    handleInput(keyData: string) {
        // Wheel scrolling (only delivered while shown as a focused overlay).
        const wheelDelta = this.parseWheel(keyData);
        if (wheelDelta !== null) {
            if (this.wrappedTitle.length > this.windowHeight) {
                this.scrollTitle(wheelDelta * 3);
            }
            return;
        }

        // Page scrolling of the title window.
        if (matchesKey(keyData, Key.pageUp)) {
            this.scrollTitle(-this.windowHeight);
            return;
        }
        if (matchesKey(keyData, Key.pageDown)) {
            this.scrollTitle(this.windowHeight);
            return;
        }
        if (matchesKey(keyData, Key.home)) {
            this.scrollTitle(-Infinity);
            return;
        }
        if (matchesKey(keyData, Key.end)) {
            this.scrollTitle(Infinity);
            return;
        }

        const kb = getKeybindings();

        if (this.mode === "input") {
            if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
                const message = this.noInput.getValue().trim();
                this.done({ allow: false, message: message || undefined });
            }
            else if (kb.matches(keyData, "tui.select.cancel")) {
                this.mode = "select";
                this.noInput.setValue("");
            }
            else {
                this.noInput.handleInput(keyData);
            }
            return;
        }

        // Select mode
        if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
            this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        }
        else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
            this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
        }
        else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
            this.confirmSelected();
        }
        else if (keyData === "\t") {
            if (this.canEnterInputMode) {
                this.mode = "input";
            }
        }
        else if (kb.matches(keyData, "tui.select.cancel")) {
            this.done({ allow: false });
        }
    }

    /** Dispatch the `done` callback based on the selected option's kind. */
    private confirmSelected(): void {
        const opt = this.getSelectedOption();
        if (!opt) {
            this.done({ allow: false });
            return;
        }
        switch (opt.kind) {
            case "allow":
                this.done({ allow: true });
                break;
            case "allowSession":
                this.done({ allow: true, allowSession: true });
                break;
            case "deny":
                this.done({ allow: false });
                break;
            case "denyWithMessage":
                // Match the legacy behavior: confirming the "No" option in
                // select mode denies immediately. Tab is the path to the
                // input mode where the user can attach a reason.
                this.done({ allow: false });
                break;
        }
    }

    override invalidate() {
        // Invalidate the border so it re-renders with the current theme.
        this.border.invalidate();
        super.invalidate();
    }

    dispose() {}
}
