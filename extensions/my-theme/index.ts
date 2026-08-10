import type { ExtensionAPI, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";

import type { McpServersStatus } from "../shared/utils/types";
import { ArrowEditor } from "./ArrowEditor";
import { createFooter } from "./Footer";
import { createHeader } from "./Header";

export default function (pi: ExtensionAPI) {
    const mcpServers: McpServersStatus[] = [];

    pi.on("session_start", async (_event, ctx) => {
        if (ctx.mode !== "tui") return;

        // The footer factory is the only place pi hands out the ReadonlyFooterDataProvider
        // (which exposes the git branch). Capture it here so the header can show it too.
        let footerData: ReadonlyFooterDataProvider | null = null;

        ctx.ui.setHeader((_, theme) => createHeader(ctx, theme, () => footerData, () => mcpServers));
        ctx.ui.setEditorComponent((tui, theme, kb) => new ArrowEditor(tui, theme, kb));
        ctx.ui.setFooter((_, theme, _footerData) => {
            footerData = _footerData;
            return createFooter(ctx, theme, _footerData);
        });
    });

    pi.events.on("mcp_status", (data) => {
        const _data = data as McpServersStatus[];
        mcpServers.length = 0;
        mcpServers.push(..._data);
    });

    pi.registerCommand("exit", {
        description: "Alias for /quit",
        async handler(_args, ctx) {
            ctx.shutdown();
        },
    });
}
