/**
 * Session Namer - Automatically names sessions using a small model.
 *
 * Names any unnamed session on the next user message. Uses a dedicated small
 * model when available, otherwise falls back to the session's default model.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const NAME_MODEL_PROVIDER = "llama.cpp";
const NAME_MODEL_ID = "gemma4-tiny";

type NameResult = {
    name?: string;
    error?: string;
};

async function generateName(prompt: string): Promise<NameResult> {
    const tmpDir = await mkdtemp(join(tmpdir(), "pi-session-namer-"));
    const loader = new DefaultResourceLoader({
        cwd: tmpDir,
        agentDir: getAgentDir(),
        systemPromptOverride: () => "You are a session naming assistant. Generate a short, descriptive name for a coding session. Output ONLY the name, nothing else, no markdown, no codeblocks",
        appendSystemPromptOverride: () => [],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
    });
    await loader.reload();

    const { session } = await createAgentSession({
        resourceLoader: loader,
        thinkingLevel: "off",
        sessionManager: SessionManager.inMemory(),
        noTools: "all",
    });

    try {
        const dedicated = session.modelRuntime.getModel(NAME_MODEL_PROVIDER, NAME_MODEL_ID);
        if (dedicated) {
            await session.setModel(dedicated);
            session.setThinkingLevel("off");
        }
        else {
            return { error: `Model "${NAME_MODEL_PROVIDER}/${NAME_MODEL_ID}" unavailable` };
        }

        let result = "";
        session.subscribe((event) => {
            if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
                result += event.assistantMessageEvent.delta;
            }
        });

        await session.prompt(
            `Generate a short session name (max 6 words) for this prompt:\n${prompt}`,
        );

        const name = result.trim().replace(/^["']|["']$/g, "");
        return { name: name };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Failed to generate session name: ${message}` };
    }
    finally {
        session.dispose();
        await rm(tmpDir, { recursive: true });
    }
}

export default function sessionNamer(pi: ExtensionAPI) {
    pi.on("before_agent_start", async (event, ctx) => {
        if (pi.getSessionName()) return;

        const prompt = event.prompt?.trim();
        if (!prompt) return;

        const notify = ctx.ui.notify;

        generateName(prompt).then((result) => {
            if (result.name) {
                pi.setSessionName(result.name);
            }
            else if (result.error) {
                notify(result.error, "error");
            }
        });
    });
}
