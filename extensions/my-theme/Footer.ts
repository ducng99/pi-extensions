import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function createFooter(ctx: ExtensionContext, theme: Theme, footerData: ReadonlyFooterDataProvider): Component {
    return {
        invalidate() {},

        render(width: number): string[] {
            const left = statusSection(theme, footerData.getExtensionStatuses());
            const right = modelSection(ctx, theme) + theme.fg("dim", " • ") + contextSection(ctx, theme);

            const leftWidth = visibleWidth(left);
            const rightWidth = visibleWidth(right);
            const pad = " ".repeat(Math.max(1, width - leftWidth - rightWidth));

            return [
                truncateToWidth(left + pad + right, width),
            ];
        },
    };
}

function statusSection(theme: Theme, statuses: ReadonlyMap<string, string>) {
    let out = "";

    for (const [, value] of statuses) {
        if (out) out += theme.fg("dim", " • ");
        out += value;
    }

    return out;
}

function contextSection(ctx: ExtensionContext, theme: Theme): string {
    const usage = ctx.getContextUsage();
    const tokens = usage?.tokens ?? 0;
    const max = usage?.contextWindow ?? 0;
    const percent = usage?.percent ?? 0;

    const fmt = (n: number) => {
        if (n < 1000) return `${n}`;
        if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
        return `${(n / 1_000_000).toFixed(1)}M`;
    };

    let contextStr: string;
    if (percent > 90) {
        contextStr = theme.fg("error", `${fmt(tokens)}/${fmt(max)}`);
    }
    else if (percent > 70) {
        contextStr = theme.fg("warning", `${fmt(tokens)}/${fmt(max)}`);
    }
    else {
        contextStr = theme.fg("dim", `${fmt(tokens)}/${fmt(max)}`);
    }

    return contextStr;
}

function modelSection(ctx: ExtensionContext, theme: Theme): string {
    let text = "";
    text += ctx.model ? `(${ctx.model.provider}) ${ctx.model.name}` : "(no model selected)";
    if (ctx.thinkingLevel) text += ` • ${ctx.thinkingLevel}`;
    return theme.fg("dim", text);
}
