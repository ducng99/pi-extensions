/**
 * Remote Extension
 *
 * `/remote connect <target> [path]` connects pi to a remote machine over SSH:
 * read, write, edit, bash, ls, find and grep then run on the remote machine at
 * the given path. `/remote stop` terminates the connection.
 *
 * Transport is SSH ControlMaster multiplexing where supported (the first
 * command establishes a master connection, later commands multiplex over it).
 * On Windows, whose OpenSSH lacks ControlMaster, every command opens its own
 * connection instead. Key-based auth is required either way; the master is
 * closed on /remote stop and session shutdown.
 *
 * The built-in tools are overridden at registration with thin dispatchers that
 * route to remote implementations while a session is active and to the local
 * built-in behavior otherwise. tool-permissions is told about the connection
 * (via the shared pi.events bus) so its path boundary, remote project settings,
 * and classifier git context switch to the remote machine too.
 *
 * Connection state is persisted to the session JSONL (`remote:session` custom
 * entries) and restored on session resume; reconnecting is lazy.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
    createBashTool,
    createEditTool,
    createFindTool,
    createGrepTool,
    createLsTool,
    createReadTool,
    createWriteTool,
} from "@earendil-works/pi-coding-agent";

import {
    createRemoteBashOperations,
    createRemoteEditOperations,
    createRemoteFindOperations,
    createRemoteReadOperations,
    createRemoteWriteOperations,
    remoteGrepExecute,
    remoteLsExecute,
} from "./operations";
import { closeMaster, connectRemote, createRemoteExecFn, probeCapabilities } from "./ssh";
import {
    ensureCapabilities,
    getActiveRemote,
    parseRemoteArgs,
    REMOTE_ENTRY_TYPE,
    REMOTE_STATUS_KEY,
    type RemoteEntryData,
    setActiveRemote,
} from "./state";

export default function (pi: ExtensionAPI) {
    const localCwd = process.cwd();

    // Local fallbacks, created once. Each override below dispatches between
    // these and a per-call remote tool depending on connection state.
    const localRead = createReadTool(localCwd);
    const localWrite = createWriteTool(localCwd);
    const localEdit = createEditTool(localCwd);
    const localBash = createBashTool(localCwd);
    const localLs = createLsTool(localCwd);
    const localFind = createFindTool(localCwd);
    const localGrep = createGrepTool(localCwd);

    pi.registerTool({
        ...localRead,
        async execute(id, params, signal, onUpdate, ctx) {
            const remote = getActiveRemote();
            if (!remote) return localRead.execute(id, params, signal, onUpdate);
            const tool = createReadTool(ctx.cwd, { operations: createRemoteReadOperations(remote, ctx.cwd) });
            return tool.execute(id, params, signal, onUpdate);
        },
    });

    pi.registerTool({
        ...localWrite,
        async execute(id, params, signal, onUpdate, ctx) {
            const remote = getActiveRemote();
            if (!remote) return localWrite.execute(id, params, signal, onUpdate);
            const tool = createWriteTool(ctx.cwd, { operations: createRemoteWriteOperations(remote, ctx.cwd) });
            return tool.execute(id, params, signal, onUpdate);
        },
    });

    pi.registerTool({
        ...localEdit,
        async execute(id, params, signal, onUpdate, ctx) {
            const remote = getActiveRemote();
            if (!remote) return localEdit.execute(id, params, signal, onUpdate);
            const tool = createEditTool(ctx.cwd, { operations: createRemoteEditOperations(remote, ctx.cwd) });
            return tool.execute(id, params, signal, onUpdate);
        },
    });

    pi.registerTool({
        ...localBash,
        async execute(id, params, signal, onUpdate, ctx) {
            const remote = getActiveRemote();
            if (!remote) return localBash.execute(id, params, signal, onUpdate);
            const tool = createBashTool(ctx.cwd, { operations: createRemoteBashOperations(remote, ctx.cwd) });
            return tool.execute(id, params, signal, onUpdate);
        },
    });

    pi.registerTool({
        ...localLs,
        async execute(id, params, signal, onUpdate, ctx) {
            const remote = getActiveRemote();
            if (!remote) return localLs.execute(id, params, signal, onUpdate);
            return remoteLsExecute(remote, params, signal, ctx.cwd);
        },
    });

    pi.registerTool({
        ...localFind,
        async execute(id, params, signal, onUpdate, ctx) {
            const remote = getActiveRemote();
            if (!remote) return localFind.execute(id, params, signal, onUpdate);
            const capabilities = await ensureCapabilities(remote);
            const tool = createFindTool(ctx.cwd, { operations: createRemoteFindOperations(remote, capabilities, ctx.cwd) });
            return tool.execute(id, params, signal, onUpdate);
        },
    });

    pi.registerTool({
        ...localGrep,
        async execute(id, params, signal, onUpdate, ctx) {
            const remote = getActiveRemote();
            if (!remote) return localGrep.execute(id, params, signal, onUpdate);
            const capabilities = await ensureCapabilities(remote);
            return remoteGrepExecute(remote, capabilities, params, signal, ctx.cwd);
        },
    });

    function remoteStatusText(session: { target: string; remoteCwd: string }): string {
        return `⎋ SSH: ${session.target}:${session.remoteCwd}`;
    }

    function connectMessage(session: { target: string; remoteCwd: string }): string {
        return [
            `Remote mode enabled: all filesystem and bash tools (read, write, edit, bash, ls, find, grep) now run on ${session.target}.`,
            `The working directory on the remote machine is ${session.remoteCwd}. Relative paths resolve against it.`,
        ].join("\n");
    }

    /** Persist state, update the status line, and tell tool-permissions + the model. */
    function activateRemote(ctx: ExtensionContext, session: { target: string; port?: number; remoteCwd: string }): void {
        setActiveRemote(session);
        pi.appendEntry(REMOTE_ENTRY_TYPE, { active: true, target: session.target, port: session.port, remoteCwd: session.remoteCwd } satisfies RemoteEntryData);
        ctx.ui.setStatus(REMOTE_STATUS_KEY, ctx.ui.theme.fg("accent", remoteStatusText(session)));
        pi.events.emit("remote:connected", {
            target: session.target,
            remoteCwd: session.remoteCwd,
            exec: createRemoteExecFn(session),
        });
        pi.sendMessage({
            customType: "remote",
            content: connectMessage(session),
            display: false,
        }, {
            triggerTurn: false,
        });
    }

    /** Tear down the connection and revert everything activateRemote did. */
    function deactivateRemote(ctx: ExtensionContext, notify: boolean): void {
        const remote = getActiveRemote();
        if (!remote) {
            if (notify) ctx.ui.notify("Not connected to a remote machine", "info");
            return;
        }
        closeMaster(remote);
        setActiveRemote(null);
        pi.appendEntry(REMOTE_ENTRY_TYPE, { active: false } satisfies RemoteEntryData);
        ctx.ui.setStatus(REMOTE_STATUS_KEY, undefined);
        pi.events.emit("remote:disconnected", {});
        if (notify) {
            ctx.ui.notify("Remote mode off", "info");
            pi.sendMessage({
                customType: "remote",
                content: "Remote mode disabled. All tools run on the local machine again.",
                display: false,
            }, {
                triggerTurn: false,
            });
        }
    }

    async function connectCommand(ctx: ExtensionContext, target: string, path?: string): Promise<void> {
        try {
            deactivateRemote(ctx, false);
            const session = await connectRemote(target, path);
            const capabilities = await probeCapabilities(session);
            if (!capabilities.hasRg) {
                ctx.ui.notify("rg not found on remote - grep falls back to GNU grep (no .gitignore support)", "warning");
            }
            if (!capabilities.hasFd) {
                ctx.ui.notify("fd not found on remote - find falls back to POSIX find", "warning");
            }
            activateRemote(ctx, session);
            ctx.ui.notify(`Remote mode: ${session.target}:${session.remoteCwd}`, "info");
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(`Remote connect failed: ${msg}`, "error");
        }
    }

    /**
     * Restore remote state from the session's latest `remote:session` entry.
     * Scans backwards so the newest entry (the source of truth) is found
     * immediately. Reconnecting is lazy: the first remote operation establishes
     * the SSH master.
     */
    function restoreRemoteFromSession(ctx: ExtensionContext): void {
        const entries = ctx.sessionManager.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            if (!entry || entry.type !== "custom" || entry.customType !== REMOTE_ENTRY_TYPE) {
                continue;
            }
            const data = entry.data as RemoteEntryData | undefined;
            if (data?.active && data.target && data.remoteCwd) {
                const session = { target: data.target, port: data.port, remoteCwd: data.remoteCwd };
                setActiveRemote(session);
                ctx.ui.setStatus(REMOTE_STATUS_KEY, ctx.ui.theme.fg("accent", remoteStatusText(session)));
                pi.events.emit("remote:connected", {
                    target: session.target,
                    remoteCwd: session.remoteCwd,
                    exec: createRemoteExecFn(session),
                });
            }
            else {
                setActiveRemote(null);
                ctx.ui.setStatus(REMOTE_STATUS_KEY, undefined);
                pi.events.emit("remote:disconnected", {});
            }
            return;
        }

        // Brand-new session without a remote:session entry - make sure no stale
        // state from an earlier session lingers.
        setActiveRemote(null);
        ctx.ui.setStatus(REMOTE_STATUS_KEY, undefined);
        pi.events.emit("remote:disconnected", {});
    }

    pi.on("session_start", (_, ctx) => {
        restoreRemoteFromSession(ctx);
    });

    pi.on("resources_discover", (_, ctx) => {
        restoreRemoteFromSession(ctx);
    });

    pi.on("session_shutdown", () => {
        const remote = getActiveRemote();
        if (remote) closeMaster(remote);
        setActiveRemote(null);
    });

    pi.on("user_bash", (event) => {
        const remote = getActiveRemote();
        if (!remote) return;
        return { operations: createRemoteBashOperations(remote, event.cwd) };
    });

    pi.on("before_agent_start", (event) => {
        const remote = getActiveRemote();
        if (!remote) return;
        event.systemPromptOptions.cwd = remote.remoteCwd;
    });

    pi.registerCommand("remote", {
        description: "Run all filesystem tools on a remote machine over SSH (/remote connect <target> [path] | stop | status)",
        handler: async (args, ctx) => {
            const parsed = parseRemoteArgs(args);
            switch (parsed.action) {
                case "connect":
                    await connectCommand(ctx, parsed.target, parsed.path);
                    break;
                case "stop":
                    deactivateRemote(ctx, true);
                    break;
                case "status": {
                    const remote = getActiveRemote();
                    if (remote) {
                        ctx.ui.notify(`Connected: ${remote.target}:${remote.remoteCwd}`, "info");
                    }
                    else {
                        ctx.ui.notify("Not connected to a remote machine", "info");
                    }
                    break;
                }
                case "unknown":
                    ctx.ui.notify(parsed.reason, "warning");
                    break;
            }
        },
    });
}
