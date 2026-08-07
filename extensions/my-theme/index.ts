import type { ExtensionAPI, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";

import { ArrowEditor } from "./ArrowEditor";
import { createFooter } from "./Footer";
import { createHeader } from "./Header";

export default function (pi: ExtensionAPI) {
    pi.on("session_start", async (_event, ctx) => {
        if (ctx.mode !== "tui") return;

        // The footer factory is the only place pi hands out the ReadonlyFooterDataProvider
        // (which exposes the git branch). Capture it here so the header can show it too.
        let footerData: ReadonlyFooterDataProvider | null = null;

        ctx.ui.setHeader((_, theme) => createHeader(ctx, theme, () => footerData));
        ctx.ui.setEditorComponent((tui, theme, kb) => new ArrowEditor(tui, theme, kb));
        ctx.ui.setFooter((_, theme, _footerData) => {
            footerData = _footerData;
            return createFooter(ctx, theme);
        });
    });
}
