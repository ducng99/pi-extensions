/**
 * OAuth support for MCP clients.
 *
 * - Interactive authorization-code flow (RFC 8252) using a 127.0.0.1 loopback
 *   callback, with client registrations/tokens/PKCE persisted per server under
 *   `~/.pi/agent/mcp/auth/`.
 * - `client_credentials` grant via the SDK's `ClientCredentialsProvider`.
 * - Static bearer tokens for simple servers that accept them directly.
 */

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { join } from "path";

import { authDir } from "./config";
import type { McpServerConfig } from "./types";

/* ------------------------------------------------------------------ */
/* Browser open                                                        */
/* ------------------------------------------------------------------ */

/** Open a URL in the user's default browser (best-effort, non-blocking). */
export function openUrl(url: string): void {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.unref();
}

/* ------------------------------------------------------------------ */
/* Loopback callback server                                            */
/* ------------------------------------------------------------------ */

export interface AuthorizationCallback {
    code: string;
    state: string;
}

class LoopbackServer {
    private server?: ReturnType<typeof createServer>;
    private _port = 0;
    private pending: { resolve: (cb: AuthorizationCallback) => void; timer: NodeJS.Timeout } | undefined;

    /** Bind a 127.0.0.1 listener on an ephemeral port and return that port. */
    async start(): Promise<number> {
        if (this.server) return this._port;
        await new Promise<void>((resolve, reject) => {
            const server = createServer((req: IncomingMessage, res: ServerResponse) => this.handle(req, res));
            server.on("error", reject);
            server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                this._port = typeof address === "object" && address ? address.port : 0;
                this.server = server;
                resolve();
            });
        });
        return this._port;
    }

    stop(): void {
        if (this.server) {
            this.server.close();
            this.server = undefined;
        }
    }

    get port(): number {
        return this._port;
    }

    /** Wait for the browser redirect with the authorization code + state. */
    waitForCallback(timeoutMs = 180_000): Promise<AuthorizationCallback> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending = undefined;
                reject(new Error("Authorization timed out: no callback arrived."));
            }, timeoutMs);
            this.pending = { resolve, timer };
        });
    }

    private handle(req: IncomingMessage, res: ServerResponse): void {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${this._port}`);
        if (url.pathname !== "/callback") {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not found");
            return;
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state") ?? "";
        if (this.pending) {
            clearTimeout(this.pending.timer);
            this.pending.resolve({ code: code ?? "", state });
            this.pending = undefined;
        }
        const body = code
            ? "<h1>Authorization complete.</h1><p>You can close this window and return to pi.</p>"
            : "<h1>Authorization failed.</h1><p>No authorization code was returned.</p>";
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!doctype html><html><body>${body}</body></html>`);
    }
}

/** Shared loopback listener for the whole process. */
export const loopback = new LoopbackServer();

/* ------------------------------------------------------------------ */
/* File-backed per-server credential storage                           */
/* ------------------------------------------------------------------ */

interface StoredCredential {
    client?: OAuthClientInformationMixed;
    tokens?: OAuthTokens;
    codeVerifier?: string;
    lastState?: string;
}

export function storagePath(serverKey: string): string {
    const safeName = serverKey.replace(/[^A-Za-z0-9_.-]/g, "_");
    return join(authDir(), `${safeName}.json`);
}

function readStored(file: string): StoredCredential {
    try {
        mkdirSync(authDir(), { recursive: true });
        return JSON.parse(readFileSync(file, "utf8")) as StoredCredential;
    }
    catch {
        return {};
    }
}

function saveStored(file: string, data: StoredCredential): void {
    try {
        mkdirSync(authDir(), { recursive: true });
        writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
    }
    catch {
        /* persistence failures must not break tool calls */
    }
}

/* ------------------------------------------------------------------ */
/* Interactive authorization-code provider                             */
/* ------------------------------------------------------------------ */

export class InteractiveOAuthProvider implements OAuthClientProvider {
    private store: StoredCredential;

    constructor(
        private serverKey: string,
        private clientPort: string,
        private scope?: string,
        private storageFile?: string,
    ) {
        this.file = storageFile ?? storagePath(serverKey);
        this.store = readStored(this.file);
    }

    private file: string;

    get clientMetadata(): OAuthClientMetadata {
        const metadata: OAuthClientMetadata = {
            client_name: `pi (${this.serverKey})`,
            redirect_uris: [String(this.redirectUrl)],
            grant_types: ["authorization_code", "refresh_token"],
        };
        if (this.scope) metadata.scope = this.scope;
        return metadata;
    }

    get redirectUrl(): string {
        return `http://127.0.0.1:${this.clientPort}/callback`;
    }

    state(): string {
        this.store.lastState = randomBytes(16).toString("hex");
        saveStored(this.file, this.store);
        return this.store.lastState;
    }

    clientInformation(): OAuthClientInformationMixed | undefined {
        return this.store.client;
    }

    saveClientInformation(information: OAuthClientInformationMixed): void {
        this.store.client = information;
        saveStored(this.file, this.store);
    }

    tokens(): OAuthTokens | undefined {
        return this.store.tokens;
    }

    saveTokens(tokens: OAuthTokens): void {
        this.store.tokens = tokens;
        saveStored(this.file, this.store);
    }

    redirectToAuthorization(authorizationUrl: URL): void {
        openUrl(authorizationUrl.href);
    }

    saveCodeVerifier(codeVerifier: string): void {
        this.store.codeVerifier = codeVerifier;
        saveStored(this.file, this.store);
    }

    codeVerifier(): string {
        if (!this.store.codeVerifier) throw new Error("no code verifier saved");
        return this.store.codeVerifier;
    }

    invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
        if (scope === "all" || scope === "client") this.store.client = undefined;
        if (scope === "all" || scope === "tokens") this.store.tokens = undefined;
        if (scope === "all" || scope === "verifier") this.store.codeVerifier = undefined;
        saveStored(this.file, this.store);
    }

    /** Verify the loopback callback `state` matches issued state. */
    validateState(state: string): boolean {
        return Boolean(state) && state === this.store.lastState;
    }
}

/* ------------------------------------------------------------------ */
/* Static bearer-token provider                                        */
/* ------------------------------------------------------------------ */

export class StaticTokenProvider implements OAuthClientProvider {
    constructor(private tokenValue: string) {}

    get clientMetadata(): OAuthClientMetadata {
        return { client_name: "pi (static token)", redirect_uris: [] };
    }

    get redirectUrl(): undefined {
        return undefined;
    }

    clientInformation(): OAuthClientInformationMixed | undefined {
        return undefined;
    }

    tokens(): OAuthTokens | undefined {
        return { access_token: this.tokenValue, token_type: "Bearer" };
    }

    saveClientInformation(): void {
        /* static credentials: no dynamic registration */
    }

    saveTokens(): void {
        /* keep the configured token */
    }

    redirectToAuthorization(): void {
        /* nothing to display */
    }

    saveCodeVerifier(): void {
        /* no PKCE */
    }

    codeVerifier(): string {
        throw new Error("Static token provider has no PKCE verifier");
    }
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

/** Build the appropriate auth provider for a server config. */
export function makeAuthProvider(config: McpServerConfig, port: number): OAuthClientProvider | undefined {
    if (config.auth === "none") return undefined;
    if (config.auth === "client_credentials" && config.clientId) {
        return new ClientCredentialsProvider({
            clientId: config.clientId,
            clientSecret: config.clientSecret ?? "",
        });
    }
    if (config.token) return new StaticTokenProvider(config.token);
    return new InteractiveOAuthProvider(config.key, String(port));
}
