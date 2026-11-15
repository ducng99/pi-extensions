import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

/** CLI flag registered by tool-permissions. A pi process started with it forwards every permission decision to its parent. */
export const PERMISSION_PROXY_FLAG = "permission-proxy";

/** Title of the RPC `input` UI request that carries a permission request from a child process. */
export const PERMISSION_PROXY_TITLE = "pi:permission-request:v1";

/** Event bus channel on which the subagent extension asks tool-permissions in the parent process to decide. */
export const PERMISSION_REQUEST_EVENT = "permission:request";

export interface PermissionProxyContextFile {
    path: string;
    content: string;
}

/** Sent by the child process. Everything the classifier sees comes from the child's own session. */
export interface PermissionProxyRequest {
    toolName: string;
    input: Record<string, unknown>;
    cwd: string;
    entries: SessionEntry[];
    contextFiles: PermissionProxyContextFile[];
}

/** Maps onto the child's `ToolCallEventResult`. */
export interface PermissionProxyResponse {
    block: boolean;
    reason?: string;
    terminate?: boolean;
}

/** Claude-style settings object holding the subagent definition's own allow/deny rules. */
export interface PermissionProxyExtraSettings {
    permissions: { allow: string[]; ask: string[]; deny: string[] };
}

/** Payload of {@link PERMISSION_REQUEST_EVENT}. The tool-permissions listener sets `result` synchronously. When it stays undefined nobody handles permissions and the request must be denied. */
export interface PermissionRequestEvent {
    ctx: ExtensionContext;
    signal?: AbortSignal;
    agent: string;
    request: PermissionProxyRequest;
    extraSettings: PermissionProxyExtraSettings | null;
    result?: Promise<PermissionProxyResponse>;
}
