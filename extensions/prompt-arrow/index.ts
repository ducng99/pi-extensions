import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

class ArrowEditor extends CustomEditor {
    override render(width: number): string[] {
        super.setPaddingX(2);
        const lines = super.render(width);
        if (lines.length < 2) return lines;

        lines[1] = "❯" + lines[1]!.substring(1);

        return lines;
    }
}

export default function (pi: ExtensionAPI) {
    pi.on("session_start", (_event, ctx) => {
        ctx.ui.setEditorComponent((tui, theme, kb) => new ArrowEditor(tui, theme, kb));
    });
}
