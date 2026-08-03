import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
    pi.on("session_start", async (_event, ctx) => {
        ctx.ui.setFooter((_, theme, footerData) => ({
            invalidate() {},
            render(width: number): string[] {
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

                const modelName = ctx.model?.id || "no-model";
                const right = theme.fg("dim", modelName);
                const leftWidth = visibleWidth(contextStr);
                const rightWidth = visibleWidth(right);
                const pad = " ".repeat(Math.max(1, width - leftWidth - rightWidth));

                let cwd = ctx.sessionManager.getCwd();
                const home = process.env.HOME || process.env.USERPROFILE;
                if (home && cwd.startsWith(home)) {
                    cwd = "~" + cwd.slice(home.length);
                }
                const branch = footerData?.getGitBranch();
                if (branch) cwd += ` (${branch})`;
                const pwdLine = truncateToWidth(theme.fg("dim", cwd), width);
                return [pwdLine, truncateToWidth(contextStr + pad + right, width)];
            },
        }));
    });
}
