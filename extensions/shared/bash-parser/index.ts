// ============================================================================
// Bash Command Parser (Tree-Sitter Implementation)
// ============================================================================
//
// Parses bash commands using tree-sitter and splits them into top-level
// commands for permission checking.
//
// Returns:
//   - "commands": normal parseable top-level commands
//   - "complex":  tree-sitter parsed the input, but it contains complex
//                 structures (substitutions, heredocs, subshells, etc.) that
//                 we do not recurse into. The top-level commands are still
//                 returned so callers can check deny rules against them.
//   - "error":    tree-sitter could not parse the input at all.

import path from "path";
import { fileURLToPath } from "url";
import { Language, Node, Parser } from "web-tree-sitter";

// ============================================================================
// Types
// ============================================================================

export interface LeafCommand {
    /** The reconstructed arg string for this top-level command */
    argString: string;
}

// Alias for backward compatibility with tests
export type ParsedCommand = LeafCommand;

export type ParseResult
    = | { kind: "commands"; commands: LeafCommand[] }
        | { kind: "complex"; commands: LeafCommand[] }
        | { kind: "error" };

interface ExtractedCommand {
    argString: string;
    isComplex: boolean;
}

// ============================================================================
// Parser Initialization (Eager Loading)
// ============================================================================

let parserInstance: Parser | null = null;
let initializationPromise: Promise<void> | null = null;

/**
 * Initialize tree-sitter parser (called once during extension startup).
 * Can be called multiple times safely - subsequent calls return immediately.
 */
export async function initParser(): Promise<void> {
    if (parserInstance) {
        return;
    }

    if (initializationPromise) {
        return initializationPromise;
    }

    initializationPromise = (async () => {
        try {
            // Initialize parser
            await Parser.init();
            const parser = new Parser();

            // Load bash language WASM
            // Resolve relative to this source file (shared/bash-parser/index.ts -> tree-sitter-bash.wasm)
            const srcDir = path.dirname(fileURLToPath(import.meta.url));
            const wasmPath = path.join(srcDir, "tree-sitter-bash.wasm");

            let bashLanguage: Language | null = null;
            try {
                bashLanguage = await Language.load(wasmPath);
            }
            catch (e) {
                throw new Error(
                    `Failed to load tree-sitter-bash.wasm from ${wasmPath}: ${typeof e === "object" && e !== null && "message" in e ? e.message : "unknown"}`,
                    { cause: e },
                );
            }

            if (!bashLanguage) {
                throw new Error("Could not find tree-sitter-bash.wasm in any expected location");
            }

            parser.setLanguage(bashLanguage);
            parserInstance = parser;
        }
        catch (error) {
            console.error("Failed to initialize tree-sitter parser:", error);
            // Keep parserInstance as null so we fall back to error
            throw error;
        }
    })();

    return initializationPromise;
}

/**
 * Check if parser is initialized (for debugging/testing).
 */
export function isParserInitialized(): boolean {
    return parserInstance !== null;
}

// ============================================================================
// AST Walking: Extract top-level commands
// ============================================================================

const SEPARATOR_TYPES = new Set([";", "&", "&&", "||", "\n", "newline"]);

function isSeparator(type: string): boolean {
    return SEPARATOR_TYPES.has(type);
}

const COMPLEX_NODE_TYPES = new Set([
    "subshell",
    "command_substitution",
    "process_substitution",
    "heredoc_redirect",
    "heredoc_body",
    "heredoc_start",
    "function_definition",
    "for_statement",
    "while_statement",
    "if_statement",
    "case_statement",
    "select_statement",
]);

function isComplexNodeType(type: string): boolean {
    return COMPLEX_NODE_TYPES.has(type);
}

function hasComplexDescendant(node: Node): boolean {
    if (isComplexNodeType(node.type)) {
        return true;
    }
    for (const child of node.children) {
        if (hasComplexDescendant(child)) {
            return true;
        }
    }
    return false;
}

function isFindExec(node: Node): boolean {
    if (node.type !== "command") return false;

    const name = node.children.find(c => c.type === "command_name");
    if (!name || name.text !== "find") return false;

    for (const child of node.children) {
        if (child.type === "word" && (child.text === "-exec" || child.text === "-execdir")) {
            return true;
        }
    }
    return false;
}

function isComplexCommand(node: Node): boolean {
    return isFindExec(node) || hasComplexDescendant(node);
}

/**
 * Recursively extract top-level commands from an AST node.
 *
 * We descend into programs, command lists, logical expressions, and pipelines
 * so that `&&`, `||`, `;`, `&`, `|`, and newlines split commands.
 *
 * We do NOT descend into subshells, command substitutions, process
 * substitutions, heredocs, or other complex structures; those are kept as a
 * single complex command.
 */
function normalizeCommandText(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function extractTopLevelCommands(node: Node): ExtractedCommand[] {
    const commands: ExtractedCommand[] = [];

    switch (node.type) {
        case "program":
        case "command_list":
        case "logical_expression": {
            for (const child of node.children) {
                if (isSeparator(child.type)) continue;
                commands.push(...extractTopLevelCommands(child));
            }
            break;
        }

        case "pipeline": {
            for (const child of node.children) {
                if (child.type === "|" || child.type === "|&") continue;
                commands.push(...extractTopLevelCommands(child));
            }
            break;
        }

        case "command":
        case "redirected_statement":
        case "declaration_command":
        case "negated_command":
        case "test_command": {
            commands.push({
                argString: normalizeCommandText(node.text),
                isComplex: isComplexCommand(node),
            });
            break;
        }

        case "subshell":
        case "command_substitution":
        case "process_substitution":
        case "heredoc_redirect":
        case "heredoc_body":
        case "heredoc_start":
        case "function_definition":
        case "for_statement":
        case "while_statement":
        case "if_statement":
        case "case_statement":
        case "select_statement": {
            commands.push({ argString: normalizeCommandText(node.text), isComplex: true });
            break;
        }

        default: {
            for (const child of node.children) {
                commands.push(...extractTopLevelCommands(child));
            }
        }
    }

    return commands;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Parse a bash command string using tree-sitter.
 *
 * @param input - The bash command string to parse
 * @returns ParseResult with top-level commands, or "complex" / "error"
 */
export function parseBashCommand(input: string): ParseResult {
    const trimmed = input.trim();
    if (!trimmed) {
        return { kind: "commands", commands: [] };
    }

    // If parser not initialized, fall back to error
    if (!parserInstance) {
        console.warn("Tree-sitter parser not initialized, returning error");
        return { kind: "error" };
    }

    try {
        const tree = parserInstance.parse(trimmed);

        if (!tree) {
            return { kind: "error" };
        }

        // If tree-sitter has parse errors, we cannot trust the result.
        if (hasErrorNode(tree.rootNode)) {
            return { kind: "error" };
        }

        const commands = extractTopLevelCommands(tree.rootNode);
        const isComplex = commands.some(cmd => cmd.isComplex);

        if (isComplex) {
            return {
                kind: "complex",
                commands: commands.map(cmd => ({ argString: cmd.argString })),
            };
        }

        return {
            kind: "commands",
            commands: commands.map(cmd => ({ argString: cmd.argString })),
        };
    }
    catch (error) {
        console.error("Error parsing bash command:", error);
        return { kind: "error" };
    }
}

/**
 * Check if the AST contains an ERROR node (indicates syntax error).
 */
function hasErrorNode(node: Node): boolean {
    if (node.type === "ERROR") {
        return true;
    }
    for (const child of node.children) {
        if (hasErrorNode(child)) {
            return true;
        }
    }
    return false;
}
