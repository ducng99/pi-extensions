import { DynamicBorder, keyHint, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Input, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";

// ============================================================================
// Custom Permission Selector Component
// ============================================================================

export interface PermissionResult {
    allow: boolean;
    message?: string;
}

/** Input without the "> " prompt */
class InlineInput extends Input {
    render(width: number): string[] {
        const lines = super.render(width);
        // Strip the hardcoded "> " prompt (first 2 chars)
        if (lines.length > 0 && lines[0].startsWith("> ")) {
            lines[0] = lines[0].slice(2);
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

    render(width: number): string[] {
        const lines = this.input.render(width - this.prefix.length);
        if (lines.length > 0) {
            lines[0] = truncateToWidth(this.prefix + lines[0], width);
        }
        return lines;
    }
}

export class PermissionSelector extends Container {
    private selectedIndex = 0;
    private options = ["Yes", "No"];
    private mode: "select" | "input" = "select";
    private noInput: NoInputInline;
    private title: string;
    private done: (result: PermissionResult) => void;

    constructor(title: string, done: (result: PermissionResult) => void) {
        super();
        this.done = done;
        this.title = title;
        this.noInput = new NoInputInline();
        this.rebuild();
    }

    private getHints(): string {
        if (this.mode === "input") {
            return `${keyHint("tui.select.confirm", "submit")}  ${keyHint("tui.select.cancel", "back")}`;
        }
        return `${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "cancel")}  ${rawKeyHint("Tab", "deny with message")}`;
    }

    private rebuild() {
        this.clear();
        this.addChild(new DynamicBorder());
        this.addChild(new Spacer(1));
        this.addChild(new Text(this.title, 1, 0));
        this.addChild(new Spacer(1));

        for (let i = 0; i < this.options.length; i++) {
            const isSelected = i === this.selectedIndex;
            const label = isSelected ? "→ " : "  ";

            if (isSelected && this.mode === "input" && i === 1) {
                // Show inline "→ No, <input>"
                this.noInput.setPrefix(" " + label + "No, ");
                this.addChild(this.noInput);
            }
            else {
                this.addChild(new Text(label + this.options[i], 1, 0));
            }
        }

        this.addChild(new Spacer(1));
        this.addChild(new Text(this.getHints(), 1, 0));
        this.addChild(new Spacer(1));
        this.addChild(new DynamicBorder());
    }

    handleInput(keyData: string) {
        const kb = getKeybindings();

        if (this.mode === "input") {
            if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
                const message = this.noInput.getValue().trim();
                this.done({ allow: false, message: message || undefined });
            }
            else if (kb.matches(keyData, "tui.select.cancel")) {
                this.mode = "select";
                this.noInput.setValue("");
                this.rebuild();
            }
            else {
                this.noInput.handleInput(keyData);
                // Rebuild to update the input display
                this.rebuild();
            }
            return;
        }

        // Select mode
        if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
            this.selectedIndex = Math.max(0, this.selectedIndex - 1);
            this.rebuild();
        }
        else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
            this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
            this.rebuild();
        }
        else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
            if (this.selectedIndex === 0) {
                this.done({ allow: true });
            }
            else {
                this.done({ allow: false });
            }
        }
        else if (keyData === "\t") {
            if (this.selectedIndex === 1) {
                this.mode = "input";
                this.rebuild();
            }
        }
        else if (kb.matches(keyData, "tui.select.cancel")) {
            this.done({ allow: false });
        }
    }

    dispose() {}
}
