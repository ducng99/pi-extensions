import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let model: Model<Api> | null = null;
let thinkingLevel: ModelThinkingLevel | null = null;

export default function (pi: ExtensionAPI) {
    pi.on("session_before_switch", async (_, ctx) => {
        if (ctx.model) {
            model = ctx.model;
            const _thinkingLevel = pi.getThinkingLevel();
            if (_thinkingLevel) {
                thinkingLevel = _thinkingLevel;
            }
        }
    });

    pi.on("session_start", async () => {
        if (model) {
            await pi.setModel(model);
            if (thinkingLevel) {
                pi.setThinkingLevel(thinkingLevel);
            }
        }
    });
}
