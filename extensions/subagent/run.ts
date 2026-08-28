/**
 * Subagent process spawning and JSONL output parsing.
 */

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import type { AgentConfig, BackgroundTaskInfo, Message, SingleResult, UsageStats } from "./types";

let doSpawn: typeof spawn = spawn;

/**
 * Testing hook: replace the underlying process spawner.
 * Used instead of mock.module("child_process") so the mock does not leak to
 * other test files that share the same test worker and also import from
 * `child_process`.
 */
export function setSpawnForTests(fn: typeof spawn): void {
    doSpawn = fn;
}

const SUBAGENT_PERMISSIONS_ENV_VAR = "PI_SUBAGENT_PERMISSIONS_FILE";

// Background tasks are kept in a weak registry so we can clean up old temp
// directories when the process stays alive long enough.
const backgroundTaskRegistry = new Map<string, BackgroundTaskInfo>();

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
    const currentScript = process.argv[1];
    const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
    if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
        return { command: process.execPath, args: [currentScript, ...args] };
    }

    const execName = path.basename(process.execPath).toLowerCase();
    const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
    if (!isGenericRuntime) {
        return { command: process.execPath, args };
    }

    return { command: "pi", args };
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
    const safeName = agentName.replace(/[^\w.-]+/g, "_");
    const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
    await withFileMutationQueue(filePath, async () => {
        await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
    });
    return { dir: tmpDir, filePath };
}

function toolsToClaudeSettingsJson(
    tools: string[] | undefined,
    disallowedTools: string[] | undefined,
): { permissions: { allow: string[]; ask: string[]; deny: string[] } } | null {
    const allow = tools ?? [];
    const deny = disallowedTools ?? [];
    if (allow.length === 0 && deny.length === 0) return null;
    return { permissions: { allow, ask: [], deny } };
}

async function writeAgentPermissionsTempFile(
    agent: AgentConfig,
): Promise<{ dir: string; filePath: string } | null> {
    const settings = toolsToClaudeSettingsJson(agent.tools, agent.disallowedTools);
    if (!settings) return null;

    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-perms-"));
    const safeName = agent.name.replace(/[^\w.-]+/g, "_");
    const filePath = path.join(tmpDir, `permissions-${safeName}.json`);

    await withFileMutationQueue(filePath, async () => {
        await fs.promises.writeFile(filePath, JSON.stringify(settings, null, 2), {
            encoding: "utf-8",
            mode: 0o600,
        });
    });

    return { dir: tmpDir, filePath };
}

export type OnUpdateCallback = (partial: {
    content: { type: "text"; text: string }[];
    details: { results: SingleResult[] };
}) => void;

/**
 * Handler for extension UI requests from the child process. The parent
 * forwards these to the main session's UI and returns the user's response.
 */
export type ExtensionUIRequestHandler = (
    request: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export async function runAgent(
    defaultCwd: string,
    agents: AgentConfig[],
    agentName: string,
    task: string,
    modelOverride: string | undefined,
    cwd: string | undefined,
    step: number | undefined,
    signal: AbortSignal | undefined,
    onUpdate: OnUpdateCallback | undefined,
    makeDetails: (results: SingleResult[]) => { results: SingleResult[] },
    handleExtensionUIRequest?: ExtensionUIRequestHandler,
): Promise<SingleResult> {
    const agent = agents.find(a => a.name === agentName);

    if (!agent) {
        const available = agents.map(a => `"${a.name}"`).join(", ") || "none";
        return {
            agent: agentName,
            agentSource: "unknown",
            task,
            exitCode: 1,
            messages: [],
            stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
            step,
        };
    }

    const args: string[] = ["--mode", "rpc", "--no-session"];
    const effectiveModel = modelOverride || agent.model;
    if (effectiveModel && effectiveModel !== "inherit") args.push("--model", effectiveModel);

    let tmpPromptDir: string | null = null;
    let tmpPermissionsDir: string | null = null;

    const usage: UsageStats = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
    };

    const currentResult: SingleResult = {
        agent: agentName,
        agentSource: agent.source,
        task,
        exitCode: 0,
        messages: [],
        stderr: "",
        usage,
        model: modelOverride || agent.model,
        step,
    };

    const emitUpdate = () => {
        if (onUpdate) {
            onUpdate({
                content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
                details: makeDetails([currentResult]),
            });
        }
    };

    const env: NodeJS.ProcessEnv = { ...process.env };
    let cleanupPermissions: (() => void) | null = null;

    try {
        if (agent.systemPrompt.trim()) {
            const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt.trim());
            tmpPromptDir = tmp.dir;
            args.push("--append-system-prompt", tmp.filePath);
        }

        const perms = await writeAgentPermissionsTempFile(agent);
        if (perms) {
            tmpPermissionsDir = perms.dir;
            env[SUBAGENT_PERMISSIONS_ENV_VAR] = perms.filePath;
            cleanupPermissions = () => {
                try {
                    if (tmpPermissionsDir) fs.rmSync(tmpPermissionsDir, { recursive: true, force: true });
                }
                catch {
                    /* ignore */
                }
            };
        }

        args.push(`Task: ${task}`);
        let wasAborted = false;

        const exitCode = await new Promise<number>((resolve) => {
            const invocation = getPiInvocation(args);
            const proc = doSpawn(invocation.command, invocation.args, {
                cwd: cwd ?? defaultCwd,
                shell: false,
                stdio: ["pipe", "pipe", "pipe"],
                env,
            });
            let buffer = "";
            let stdinClosed = false;

            // In RPC mode, the child process ignores CLI text arguments and only
            // starts working when it receives a `prompt` command on stdin. Send
            // the task as a prompt immediately after the child starts.
            try {
                const promptCommand = JSON.stringify({ type: "prompt", message: `Task: ${task}` }) + "\n";
                proc.stdin?.write(promptCommand);
            }
            catch {
                // stdin may be closed; the error/close handlers below will resolve.
            }

            const closeStdin = () => {
                if (stdinClosed) return;
                stdinClosed = true;
                try {
                    proc.stdin?.end();
                }
                catch {
                    /* ignore */
                }
            };

            const processLine = (line: string) => {
                if (!line.trim()) return;
                let event: Record<string, unknown>;
                try {
                    event = JSON.parse(line) as Record<string, unknown>;
                }
                catch {
                    return;
                }

                // Handle extension UI requests from the child process.
                // In RPC mode, ctx.ui.confirm()/select() emit these events and
                // wait for an extension_ui_response on stdin.
                if (event.type === "extension_ui_request" && handleExtensionUIRequest) {
                    const { id, ...request } = event;
                    if (typeof id === "string") {
                        handleExtensionUIRequest(request)
                            .then((response) => {
                                try {
                                    const reply = JSON.stringify({ type: "extension_ui_response", id, ...response }) + "\n";
                                    proc.stdin?.write(reply);
                                }
                                catch {
                                    // stdin may be closed
                                }
                            })
                            .catch(() => {
                                // Forward error as cancellation
                                try {
                                    const reply = JSON.stringify({ type: "extension_ui_response", id, cancelled: true }) + "\n";
                                    proc.stdin?.write(reply);
                                }
                                catch {
                                    // stdin may be closed
                                }
                            });
                    }
                    return;
                }

                if (event.type === "message_end" && event.message) {
                    const msg = event.message as Message;
                    currentResult.messages.push(msg);

                    if (msg.role === "assistant") {
                        currentResult.usage.turns++;
                        const usage = msg.usage;
                        if (usage) {
                            currentResult.usage.input += usage.input ?? 0;
                            currentResult.usage.output += usage.output ?? 0;
                            currentResult.usage.cacheRead += usage.cacheRead ?? 0;
                            currentResult.usage.cacheWrite += usage.cacheWrite ?? 0;
                            currentResult.usage.cost += usage.cost?.total ?? 0;
                            currentResult.usage.contextTokens = usage.totalTokens ?? 0;
                        }
                        if (!currentResult.model && msg.model) currentResult.model = msg.model;
                        if (msg.stopReason) currentResult.stopReason = msg.stopReason;
                        if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
                    }
                    emitUpdate();
                }

                if (event.type === "tool_result_end" && event.message) {
                    currentResult.messages.push(event.message as Message);
                    emitUpdate();
                }

                // The child emits `agent_settled` when it has finished processing
                // the prompt and is idle. Close stdin to let the child shut down
                // gracefully and exit so the parent doesn't have to wait for the
                // SIGTERM timeout.
                if (event.type === "agent_settled") {
                    closeStdin();
                }
            };

            proc.stdout.on("data", (data) => {
                buffer += data.toString();
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";
                for (const line of lines) processLine(line);
            });

            proc.stderr.on("data", (data) => {
                currentResult.stderr += data.toString();
            });

            proc.on("close", (code) => {
                if (buffer.trim()) processLine(buffer);
                closeStdin();
                resolve(code ?? 0);
            });

            proc.on("error", () => {
                closeStdin();
                resolve(1);
            });

            if (signal) {
                const killProc = () => {
                    wasAborted = true;
                    closeStdin();
                    proc.kill("SIGTERM");
                    setTimeout(() => {
                        if (!proc.killed) proc.kill("SIGKILL");
                    }, 5000);
                };
                if (signal.aborted) killProc();
                else signal.addEventListener("abort", killProc, { once: true });
            }
        });

        currentResult.exitCode = exitCode;
        if (wasAborted) throw new Error("Subagent was aborted");
        return currentResult;
    }
    finally {
        if (tmpPromptDir) {
            try {
                fs.rmSync(tmpPromptDir, { recursive: true, force: true });
            }
            catch {
                /* ignore */
            }
        }
        if (cleanupPermissions) {
            cleanupPermissions();
        }
    }
}

function getFinalOutput(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg?.role === "assistant") {
            for (const part of msg.content) {
                if (part.type === "text") return part.text;
            }
        }
    }
    return "";
}

const BACKGROUND_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const BACKGROUND_MAX_COUNT = 64;

function cleanupOldBackgroundTaskDirs(): void {
    const now = Date.now();
    const entries = Array.from(backgroundTaskRegistry.entries());
    for (const [id, info] of entries) {
        const started = new Date(info.startedAt).getTime();
        if (Number.isNaN(started) || now - started > BACKGROUND_MAX_AGE_MS) {
            backgroundTaskRegistry.delete(id);
            try {
                fs.rmSync(path.dirname(info.outputPath), { recursive: true, force: true });
            }
            catch {
                /* ignore */
            }
        }
    }

    if (backgroundTaskRegistry.size > BACKGROUND_MAX_COUNT) {
        const oldest = entries
            .sort((a, b) => new Date(a[1].startedAt).getTime() - new Date(b[1].startedAt).getTime())
            .slice(0, backgroundTaskRegistry.size - BACKGROUND_MAX_COUNT);
        for (const [id, info] of oldest) {
            backgroundTaskRegistry.delete(id);
            try {
                fs.rmSync(path.dirname(info.outputPath), { recursive: true, force: true });
            }
            catch {
                /* ignore */
            }
        }
    }
}

function generateBackgroundId(): string {
    return crypto.randomBytes(12).toString("hex");
}

export interface BackgroundTaskHandle extends BackgroundTaskInfo {
    done: Promise<{ exitCode: number }>;
}

export async function runAgentInBackground(
    defaultCwd: string,
    agents: AgentConfig[],
    agentName: string,
    task: string,
    cwd: string | undefined,
    modelOverride?: string,
): Promise<BackgroundTaskHandle | { error: string }> {
    const agent = agents.find(a => a.name === agentName);
    if (!agent) {
        const available = agents.map(a => `"${a.name}"`).join(", ") || "none";
        return { error: `Unknown agent: "${agentName}". Available agents: ${available}.` };
    }

    cleanupOldBackgroundTaskDirs();

    const args: string[] = ["--mode", "json", "-p", "--no-session"];
    const effectiveModel = modelOverride || agent.model;
    if (effectiveModel && effectiveModel !== "inherit") args.push("--model", effectiveModel);

    const env: NodeJS.ProcessEnv = { ...process.env };

    let tmpPromptDir: string | null = null;
    let tmpPromptPath: string | null = null;
    let tmpPermissionsDir: string | null = null;
    let tmpPermissionsPath: string | null = null;

    try {
        if (agent.systemPrompt.trim()) {
            const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
            tmpPromptDir = tmp.dir;
            tmpPromptPath = tmp.filePath;
            args.push("--append-system-prompt", tmpPromptPath);
        }

        const perms = await writeAgentPermissionsTempFile(agent);
        if (perms) {
            tmpPermissionsDir = perms.dir;
            tmpPermissionsPath = perms.filePath;
            env[SUBAGENT_PERMISSIONS_ENV_VAR] = tmpPermissionsPath;
        }

        args.push(`Task: ${task}`);

        const backgroundId = generateBackgroundId();
        const bgDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-bg-"));
        const outputPath = path.join(bgDir, "stdout.jsonl");
        const errorPath = path.join(bgDir, "stderr.txt");

        const outFd = fs.openSync(outputPath, "w");
        const errFd = fs.openSync(errorPath, "w");

        const invocation = getPiInvocation(args);
        const proc = doSpawn(invocation.command, invocation.args, {
            cwd: cwd ?? defaultCwd,
            shell: false,
            stdio: ["ignore", outFd, errFd],
            env,
            detached: true,
        });

        let closeResolver: ((value: { exitCode: number }) => void) | null = null;
        const done = new Promise<{ exitCode: number }>((resolve) => {
            closeResolver = resolve;
        });

        proc.on("error", () => {
            try {
                fs.closeSync(outFd);
                fs.closeSync(errFd);
                fs.rmSync(bgDir, { recursive: true, force: true });
            }
            catch {
                /* ignore */
            }
            closeResolver?.({ exitCode: 1 });
        });

        proc.on("close", (code) => {
            try {
                fs.closeSync(outFd);
                fs.closeSync(errFd);
            }
            catch {
                /* ignore */
            }
            closeResolver?.({ exitCode: code ?? 0 });
        });

        proc.unref();

        const info: BackgroundTaskHandle = {
            backgroundId,
            pid: proc.pid ?? -1,
            agent: agentName,
            task,
            outputPath,
            errorPath,
            startedAt: new Date().toISOString(),
            done,
        };
        backgroundTaskRegistry.set(backgroundId, info);
        return info;
    }
    catch (err) {
        if (tmpPromptPath) {
            try {
                fs.unlinkSync(tmpPromptPath);
            }
            catch {
                /* ignore */
            }
        }
        if (tmpPromptDir) {
            try {
                fs.rmdirSync(tmpPromptDir);
            }
            catch {
                /* ignore */
            }
        }
        if (tmpPermissionsPath) {
            try {
                fs.unlinkSync(tmpPermissionsPath);
            }
            catch {
                /* ignore */
            }
        }
        if (tmpPermissionsDir) {
            try {
                fs.rmdirSync(tmpPermissionsDir);
            }
            catch {
                /* ignore */
            }
        }
        return { error: `Failed to start background agent: ${err instanceof Error ? err.message : String(err)}` };
    }
}

export function getBackgroundTaskInfo(backgroundId: string): BackgroundTaskInfo | undefined {
    return backgroundTaskRegistry.get(backgroundId);
}

export function listBackgroundTasks(): BackgroundTaskInfo[] {
    return Array.from(backgroundTaskRegistry.values());
}
