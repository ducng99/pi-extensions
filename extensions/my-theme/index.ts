import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ArrowEditor } from "./ArrowEditor";
import { createFooter } from "./Footer";
import { createHeader } from "./Header";

export default function (pi: ExtensionAPI) {
    pi.on("session_start", async (_event, ctx) => {
        if (ctx.mode !== "tui") return;

        ctx.ui.setHeader((_, theme) => createHeader(ctx, theme));
        ctx.ui.setEditorComponent((tui, theme, kb) => new ArrowEditor(tui, theme, kb));
        ctx.ui.setFooter((_, theme, footerData) => createFooter(ctx, theme, footerData));
    });
}
