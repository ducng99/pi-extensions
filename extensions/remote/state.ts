import type { RemoteCapabilities, RemoteSession } from "./ssh";
import { probeCapabilities } from "./ssh";

/** Shape of the custom session entry used to persist remote state across resumes. */
export interface RemoteEntryData {
    active: boolean;
    target?: string;
    port?: number;
    remoteCwd?: string;
}

export const REMOTE_ENTRY_TYPE = "remote:session";
export const REMOTE_STATUS_KEY = "status:remote";

let activeSession: RemoteSession | null = null;
let capabilitiesPromise: Promise<RemoteCapabilities> | null = null;

export function getActiveRemote(): RemoteSession | null {
    return activeSession;
}

export function setActiveRemote(session: RemoteSession | null): void {
    activeSession = session;
    capabilitiesPromise = null;
}

/** Probe the remote's tool availability once per connection. */
export function ensureCapabilities(session: RemoteSession): Promise<RemoteCapabilities> {
    if (activeSession !== session) {
        throw new Error("Remote session is no longer active");
    }
    if (!capabilitiesPromise) {
        capabilitiesPromise = probeCapabilities(session).catch((err) => {
            capabilitiesPromise = null;
            throw err;
        });
    }
    return capabilitiesPromise;
}

export type RemoteCommand
    = | { action: "connect"; target: string; path?: string }
        | { action: "stop" }
        | { action: "status" }
        | { action: "unknown"; reason: string };

export function parseRemoteArgs(args: string): RemoteCommand {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { action: "status" };

    const [sub, ...rest] = parts as [string, ...string[]];
    if (sub === "stop") return { action: "stop" };
    if (sub === "status") return { action: "status" };
    if (sub === "connect") {
        if (rest.length === 0 || rest.length > 2) {
            return { action: "unknown", reason: "Usage: /remote connect <target> [path]" };
        }
        return { action: "connect", target: rest[0]!, path: rest[1] };
    }
    return {
        action: "unknown",
        reason: `Unknown subcommand "${sub}". Usage: /remote connect <target> [path] | /remote stop | /remote status`,
    };
}
