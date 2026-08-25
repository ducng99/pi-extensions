import { createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ModelData } from "./types";

const PROVIDER_ID = "aimachine";
const BASE_URL = process.env.TOM_API_URL ?? "http://localhost:8080/v1";

export default async function (pi: ExtensionAPI) {
    pi.registerProvider(createProvider({
        id: PROVIDER_ID,
        name: "AI Machine",
        baseUrl: BASE_URL,
        auth: {
            apiKey: {
                name: "Tom API key",
                async login(interaction) {
                    return {
                        type: "api_key",
                        key: await interaction.prompt({ type: "secret", message: "API key" }),
                    };
                },
                async resolve({ credential }) {
                    return credential?.key
                        ? { auth: { apiKey: credential.key }, source: "stored API key" }
                        : undefined;
                },
            },
        },
        models: [],
        async fetchModels(context) {
            const response = await fetch(BASE_URL + "/models", {
                headers: {
                    Authorization: `Bearer ${context.credential?.key}`,
                },
                signal: context.signal,
            });
            const models = (await response.json() as { data: ModelData[] }).data;

            return models.map((model) => {
                const input: ("text" | "image")[] = ["text"];
                if (model.capabilities?.vision) {
                    input.push("image");
                }

                return {
                    id: model.id,
                    name: model.id,
                    api: "openai-completions",
                    provider: PROVIDER_ID,
                    baseUrl: BASE_URL,
                    reasoning: model.capabilities?.reasoning ?? true,
                    thinkingLevelMap: {
                        off: model.capabilities?.thinkingCanDisable ? "off" : null,
                    },
                    input,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: model.capabilities?.contextWindow ?? 1_001_000,
                    maxTokens: model.max_completion_tokens ?? 131072,
                } satisfies Model<"openai-completions">;
            });
        },
        api: openAICompletionsApi(),
    }));
}
