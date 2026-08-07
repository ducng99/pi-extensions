import { CustomEditor } from "@earendil-works/pi-coding-agent";

export class ArrowEditor extends CustomEditor {
    override render(width: number): string[] {
        super.setPaddingX(2);
        const lines = super.render(width);
        if (lines.length < 2) return lines;

        lines[1] = "❯" + lines[1]!.substring(1);

        return lines;
    }
}
