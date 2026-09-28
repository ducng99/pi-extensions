/**
 * Startup connects must never open a browser or block on an OAuth callback.
 *
 * Spins up a tiny streamable-HTTP MCP endpoint that rejects every request with
 * 401 and implements OAuth discovery + dynamic registration, so the client's
 * authorization-code flow runs up to the point where it would open the browser.
 * A non-interactive connect has to refuse there (no redirect, no waiting for a
 * loopback callback) and surface an `authRequired` status telling the user to
 * re-authenticate manually with `/mcp reconnect <key>`.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import type { Server } from "http";
import { createServer } from "http";
import * as os from "os";
import { tmpdir } from "os";
import { join } from "path";

import { Registry } from "../src/registry";
import type { McpServerConfig } from "../src/types";

interface FakePi {
    registerTool: (tool: unknown) => void;
    on: (event: string, handler: unknown) => void;
}

describe("expired authorization during a background connect", () => {
    let dir: string;
    let server: Server;
    let baseUrl: string;

    const fakePi: FakePi = {
        registerTool: () => {},
        on: () => {},
    };

    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), "pi-mcp-auth-test-"));
        // Keep OAuth credential writes (client registration, PKCE verifier)
        // hermetic — same trick as registry.test.ts.
        mock.module("os", () => ({
            ...os,
            homedir: () => dir,
        }));

        server = createServer((req, res) => {
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            const json = (status: number, body: unknown): void => {
                res.writeHead(status, { "Content-Type": "application/json" });
                res.end(JSON.stringify(body));
            };

            // The MCP endpoint always rejects: the stored tokens are "expired".
            if (req.method === "POST" && url.pathname === "/mcp") {
                res.writeHead(401, { "Content-Type": "text/plain" });
                res.end("unauthorized");
                return;
            }
            // RFC 8414 authorization server metadata (PRM is unsupported and
            // falls back to the server origin).
            if (url.pathname === "/.well-known/oauth-authorization-server") {
                json(200, {
                    issuer: baseUrl,
                    authorization_endpoint: `${baseUrl}/authorize`,
                    token_endpoint: `${baseUrl}/token`,
                    registration_endpoint: `${baseUrl}/register`,
                    response_types_supported: ["code"],
                    grant_types_supported: ["authorization_code", "refresh_token"],
                    code_challenge_methods_supported: ["S256"],
                });
                return;
            }
            // Dynamic client registration (RFC 7591).
            if (req.method === "POST" && url.pathname === "/register") {
                let redirectUris = ["http://127.0.0.1/callback"];
                let body = "";
                req.on("data", (chunk) => {
                    body += chunk;
                });
                req.on("end", () => {
                    try {
                        const parsed = JSON.parse(body) as { redirect_uris?: string[] };
                        if (Array.isArray(parsed.redirect_uris) && parsed.redirect_uris.length) {
                            redirectUris = parsed.redirect_uris;
                        }
                    }
                    catch { /* fall back to a placeholder redirect */ }
                    json(201, { client_id: "test-client", redirect_uris: redirectUris });
                });
                return;
            }
            // Everything else (incl. protected-resource metadata) is unsupported.
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("not found");
        });
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    });

    afterAll(() => {
        server.closeAllConnections?.();
        server.close();
        rmSync(dir, { recursive: true, force: true });
    });

    test("refuses the browser flow and reports authRequired instead of blocking", async () => {
        const registry = new Registry();
        const config: McpServerConfig = {
            key: "expired-server",
            label: "expired-server",
            type: "http",
            url: `${baseUrl}/mcp`,
            auth: "authorization_code",
        };

        // Background (non-interactive) attempt — the session-start default.
        const status = await registry.connectOne(fakePi as never, config);

        expect(status.connected).toBe(false);
        expect(status.authRequired).toBe(true);
        expect(status.error).toContain("/mcp reconnect expired-server");

        // The flag survives into the statuses `/mcp status` renders.
        expect(registry.statuses()[0]?.authRequired).toBe(true);

        await registry.disconnectAll();
    });
});
