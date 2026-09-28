/**
 * Gating of the interactive browser OAuth flow: background connects (session
 * start) must never open a browser — they refuse with a re-auth hint instead.
 * Only explicitly interactive attempts keep the redirect behavior.
 */

import { describe, expect, test } from "bun:test";

import { InteractiveAuthRequiredError, InteractiveOAuthProvider, makeAuthProvider } from "../src/oauth";
import type { McpServerConfig } from "../src/types";

const config: McpServerConfig = {
    key: "needs-auth",
    label: "needs-auth",
    type: "http",
    url: "https://example.com/mcp",
    auth: "authorization_code",
};

function provider(opts?: { interactive?: boolean }): InteractiveOAuthProvider {
    const created = makeAuthProvider(config, 41234, opts);
    if (!(created instanceof InteractiveOAuthProvider)) throw new Error("expected an InteractiveOAuthProvider");
    return created;
}

describe("OAuth interactive-flow gating", () => {
    test("providers are non-interactive unless explicitly enabled", () => {
        expect(provider().interactive).toBe(false);
        expect(provider({ interactive: true }).interactive).toBe(true);
    });

    test("non-interactive providers refuse instead of opening the browser", () => {
        expect(() => provider().redirectToAuthorization(new URL("https://as.example/authorize?x=1")))
            .toThrow(InteractiveAuthRequiredError);
    });

    test("the refusal names the server and the reconnect command", () => {
        expect(() => provider().redirectToAuthorization(new URL("https://as.example/authorize")))
            .toThrow(/\/mcp reconnect needs-auth/);
    });

    test("static-token servers never require the interactive flow", () => {
        const staticProvider = makeAuthProvider({ ...config, auth: undefined, token: "abc" }, 0);
        // Static tokens bypass authorization entirely, so a redirect never happens.
        expect(staticProvider?.tokens()).toEqual({ access_token: "abc", token_type: "Bearer" });
    });
});
