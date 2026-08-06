/**
 * Unit tests for the JSON Schema → TypeBox converter and the OAuth provider.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { TSchema } from "typebox";

import { schemaFromParameters } from "../src/jsonSchema";
import { InteractiveOAuthProvider, loopback } from "../src/oauth";

function propType(schema: TSchema, key: string): string | undefined {
    const obj = schema as { properties?: Record<string, { type?: string; anyOf?: { type?: string }[] }> };
    const prop = obj.properties?.[key];
    if (!prop) return undefined;
    if (prop.anyOf) return `anyOf:${prop.anyOf.map(x => x.type).join("|")}`;
    return prop.type;
}

describe("jsonSchemaToTypeBox", () => {
    test("maps primitives and required fields", () => {
        const schema = schemaFromParameters({
            type: "object",
            properties: {
                name: { type: "string" },
                count: { type: "integer" },
                ratio: { type: "number" },
                ok: { type: "boolean" },
            },
            required: ["name"],
        });
        expect(propType(schema, "name")).toBe("string");
        expect(propType(schema, "count")).toBe("integer");
        expect(propType(schema, "ratio")).toBe("number");
        expect(propType(schema, "ok")).toBe("boolean");
        expect((schema as { required?: string[] }).required).toEqual(["name"]);
    });

    test("maps enums, arrays, and unions", () => {
        const schema = schemaFromParameters({
            type: "object",
            properties: {
                mode: { type: "string", enum: ["a", "b", "c"] },
                tags: { type: "array", items: { type: "string" } },
                maybe: { type: ["string", "null"] },
            },
        });
        expect(propType(schema, "mode")).toBe("anyOf:string|string|string");
        expect(propType(schema, "tags")).toBe("array");
        expect(propType(schema, "maybe")).toBe("anyOf:string|null");
    });

    test("returns an empty object for non-object roots", () => {
        const schema = schemaFromParameters({ type: "string" });
        expect((schema as { properties?: Record<string, unknown> }).properties ?? {}).toEqual({});
    });

    test("resolves $ref against $defs", () => {
        const schema = schemaFromParameters({
            type: "object",
            properties: {
                point: { $ref: "#/$defs/xy" },
            },
            $defs: {
                xy: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
            },
        });
        expect(propType(schema, "point")).toBe("object");
    });
});

describe("OAuth provider", () => {
    let dir: string;
    let port: string;

    beforeAll(async () => {
        dir = join(mkdtempSync(join(tmpdir(), "pi-oauth-test-")), "cred.json");
        port = (await loopback.start()).toString();
    });

    afterAll(() => {
        rmSync(join(dir, ".."), { recursive: true, force: true });
    });

    test("persists and clears tokens at an overridable path", async () => {
        const provider = new InteractiveOAuthProvider("oauth-prime", port, undefined, dir);
        await provider.saveTokens({ access_token: "abc", token_type: "Bearer" });

        // Reload from disk proves persistence.
        const reloaded = new InteractiveOAuthProvider("oauth-prime", port, undefined, dir);
        expect((await reloaded.tokens())?.access_token).toBe("abc");

        await provider.invalidateCredentials("tokens");
        const cleared = new InteractiveOAuthProvider("oauth-prime", port, undefined, dir);
        expect(await cleared.tokens()).toBeUndefined();
    });
});
