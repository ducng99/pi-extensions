/**
 * Claude MD - Loads ~/.claude/CLAUDE.md, ~/.claude/CLAUDE.local.md and <cwd>/CLAUDE.local.md as context files.
 * When the read tool reads a file in a nested directory, AGENTS.md, CLAUDE.md and CLAUDE.local.md files in the
 * directories between cwd and that file are sent once per session as a message.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function readFileIfExists(path: string): string | undefined {
    try {
        if (!existsSync(path) || !statSync(path).isFile()) {
            return undefined;
        }
        return readFileSync(path, "utf-8");
    }
    catch {
        return undefined;
    }
}

const NESTED_FILE_NAMES = ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"];
const NESTED_MESSAGE_TYPE = "context_file";

function isInside(parent: string, child: string): boolean {
    const rel = relative(parent, child);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export default function (pi: ExtensionAPI) {
    const sentPaths = new Set<string>();

    pi.on("session_start", async () => {
        sentPaths.clear();
    });

    pi.on("tool_result", async (event, ctx) => {
        if (event.toolName !== "read" || event.isError) {
            return;
        }
        const inputPath = (event.input as { path?: unknown }).path;
        if (typeof inputPath !== "string") {
            return;
        }

        const readPath = resolve(ctx.cwd, inputPath);
        const dirs: string[] = [];
        for (let dir = dirname(readPath); isInside(ctx.cwd, dir); dir = dirname(dir)) {
            dirs.unshift(dir);
        }

        const blocks: string[] = [];
        for (const dir of dirs) {
            for (const name of NESTED_FILE_NAMES) {
                const path = join(dir, name);
                if (sentPaths.has(path)) {
                    continue;
                }
                sentPaths.add(path);
                if (path === readPath) {
                    continue;
                }
                const content = readFileIfExists(path);
                if (content === undefined || content.trim() === "") {
                    continue;
                }
                blocks.push(`<context_file path="${path}">\n${content}\n</context_file>`);
            }
        }

        if (blocks.length > 0) {
            pi.sendMessage({
                customType: NESTED_MESSAGE_TYPE,
                content: blocks.join("\n"),
                display: false,
            }, {
                triggerTurn: false,
            });
        }
    });

    pi.on("before_agent_start", async (event, ctx) => {
        const claudeDir = join(homedir(), ".claude");
        const candidates = [
            join(claudeDir, "CLAUDE.md"),
            join(claudeDir, "CLAUDE.local.md"),
            join(ctx.cwd, "CLAUDE.local.md"),
        ];

        const contextFiles = event.systemPromptOptions.contextFiles ?? [];
        const loadedPaths = new Set(contextFiles.map(file => file.path));

        for (const path of candidates) {
            if (loadedPaths.has(path)) {
                continue;
            }
            const content = readFileIfExists(path);
            if (content === undefined || content.trim() === "") {
                continue;
            }
            contextFiles.push({ path, content });
            loadedPaths.add(path);
        }

        event.systemPromptOptions.contextFiles = contextFiles;
    });
}
