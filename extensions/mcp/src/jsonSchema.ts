/**
 * Converts an MCP tool `inputSchema` (JSON Schema) into a TypeBox schema so
 * pi can register the tool. The conversion is best-effort: `type`, `enum`/`const`,
 * `anyOf`/`oneOf`, `allOf`, `$ref`, `required`/`additionalProperties` are mapped to
 * TypeBox primitives. Anything unrepresentable falls back to `Type.Unknown()`,
 * keeping registration working rather than breaking on exotic schemas.
 */

import type { TSchema } from "typebox";
import { Type } from "typebox";

interface JsonSchemaNode {
    $ref?: string;
    $defs?: Record<string, JsonSchemaNode>;
    definitions?: Record<string, JsonSchemaNode>;
    type?: string | string[];
    enum?: unknown[];
    const?: unknown;
    properties?: Record<string, JsonSchemaNode>;
    required?: string[];
    items?: JsonSchemaNode | JsonSchemaNode[];
    additionalProperties?: boolean | JsonSchemaNode;
    anyOf?: JsonSchemaNode[];
    oneOf?: JsonSchemaNode[];
    allOf?: JsonSchemaNode[];
    description?: string;
    default?: unknown;
    format?: string;
    pattern?: string;
    minLength?: number;
    maxLength?: number;
    [key: string]: unknown;
}

/** Description / default decorations for individual leaf schemas. */
function docs(node: JsonSchemaNode): Record<string, unknown> | undefined {
    const o: Record<string, unknown> = {};
    if (node.description !== undefined) o.description = node.description;
    if (node.default !== undefined) o.default = node.default;
    return Object.keys(o).length ? o : undefined;
}

function literal(value: unknown): TSchema {
    switch (typeof value) {
        case "string":
        case "number":
        case "boolean":
            return Type.Literal(value as string & number & boolean);
        default:
            return Type.Unknown();
    }
}

function requiredOr(schema: TSchema, required: boolean): TSchema {
    return required ? schema : (Type.Optional(schema) as TSchema);
}

function convert(node: JsonSchemaNode, required: boolean, defs: Record<string, JsonSchemaNode>): TSchema {
    if (node.$ref) {
        const name = node.$ref.slice(node.$ref.lastIndexOf("/") + 1);
        const target = defs[name];
        if (target) return convert(target, required, defs);
        return Type.Unknown();
    }

    const union = node.anyOf ?? node.oneOf;
    if (Array.isArray(union) && union.length > 0) {
        const members = union.map(m => convertOn(m));
        const t = members.length === 1 ? (members[0] as TSchema) : Type.Union([...members]);
        return requiredOr(t, required);
    }
    if (Array.isArray(node.allOf) && node.allOf.length > 0) {
        const t = Type.Intersect([...node.allOf.map(m => convertOptional(m))]);
        return requiredOr(t, required);
    }
    if (Array.isArray(node.enum) && node.enum.length > 0) {
        const t = node.enum.length === 1 ? literal(node.enum[0]) : Type.Union(node.enum.map(literal));
        return requiredOr(t, required);
    }
    if (node.const !== undefined) {
        return requiredOr(literal(node.const), required);
    }

    let schema: TSchema;
    if (Array.isArray(node.type)) {
        schema = Type.Union([...node.type.map(t => convert({ ...node, type: t }, false, defs))]);
    }
    else {
        switch (node.type) {
            case "string": {
                const opts = docs(node) ?? {};
                if (node.format) opts.format = node.format;
                if (node.pattern) opts.pattern = node.pattern;
                if (node.minLength !== undefined) opts.minLength = node.minLength;
                if (node.maxLength !== undefined) opts.maxLength = node.maxLength;
                schema = Type.String(opts);
                break;
            }
            case "number":
            case "integer": {
                const t = node.type === "integer" ? Type.Integer : Type.Number;
                schema = (docs(node) ? t(docs(node)) : t());
                break;
            }
            case "boolean":
                schema = Type.Boolean(docs(node));
                break;
            case "null":
                schema = Type.Null();
                break;
            case "array": {
                const items = Array.isArray(node.items) ? (node.items[0] ?? {}) : (node.items ?? {});
                schema = Type.Array(convert(items as JsonSchemaNode, false, defs));
                break;
            }
            case "object": {
                const properties: Record<string, TSchema> = {};
                const requiredList = Array.isArray(node.required) ? (node.required as string[]) : [];
                for (const [key, prop] of Object.entries(node.properties ?? {})) {
                    properties[key] = convert(prop, requiredList.includes(key), defs);
                }
                const options: Record<string, unknown> = {};
                if (node.additionalProperties === false) options.additionalProperties = false;
                schema = Type.Object(properties, options);
                break;
            }
            default:
                schema = Type.Unknown();
        }
    }

    return requiredOr(schema, required);
}

/** Left for callers that never need the `required` polarity. */
function convertOn(node: JsonSchemaNode): TSchema {
    return convert(node, false, refsOf(node));
}
function convertOptional(node: JsonSchemaNode): TSchema {
    return convert(node, false, refsOf(node));
}
function refsOf(node: JsonSchemaNode): Record<string, JsonSchemaNode> {
    return { ...(node.$defs ?? {}), ...(node.definitions ?? {}) };
}

/** Convert a JSON Schema input schema into a TypeBox parameters schema. */
export function schemaFromParameters(input: unknown): TSchema {
    const node = (input ?? {}) as JsonSchemaNode;
    const converted = convert(node, true, refsOf(node));
    return node.type === "object" ? converted : Type.Object({});
}
