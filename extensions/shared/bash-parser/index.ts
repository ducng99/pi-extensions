// ============================================================================
// Bash Command Parser (Tree-Sitter Implementation)
// ============================================================================
//
// Parses bash commands using tree-sitter and splits them into top-level
// commands for permission checking.
//
// Returns:
//   - "commands": normal parseable top-level commands. Each leaf carries an
//                 `isComplex` flag when it contains complex structures
//                 (substitutions, heredocs, subshells, etc.) that we do not
//                 recurse into, so callers can apply complex-command rules
//                 per leaf instead of for the whole input.
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
    /** The raw argument tokens as tree-sitter extracted them */
    args: string[];
    /** True if this leaf contains complex structures (subshells, heredocs, etc.) */
    isComplex: boolean;
}

// Alias for backward compatibility with tests
export type ParsedCommand = LeafCommand;

export type ParseResult
    = | { kind: "commands"; commands: LeafCommand[] }
        | { kind: "error" };

interface ExtractedCommand {
    argString: string;
    args: string[];
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

/**
 * Nodes that contain other commands and should be recursed into.
 */
const CONTAINER_NODE_TYPES = new Set([
    "program",
    "command_list",
    "list",
    "logical_expression",
    "pipeline",
    "redirected_statement",
]);

function isContainerNode(type: string): boolean {
    return CONTAINER_NODE_TYPES.has(type);
}

/**
 * Nodes that represent an individual command (or a complex structure we keep
 * whole, such as a subshell or control structure).
 */
const COMMAND_NODE_TYPES = new Set([
    "command",
    "declaration_command",
    "negated_command",
    "test_command",
    "subshell",
    "command_substitution",
    "process_substitution",
    "function_definition",
    "for_statement",
    "while_statement",
    "if_statement",
    "case_statement",
    "select_statement",
]);

function isCommandLeaf(type: string): boolean {
    return COMMAND_NODE_TYPES.has(type);
}

function isCommandNode(node: Node): boolean {
    return isContainerNode(node.type) || isCommandLeaf(node.type);
}

/**
 * Argument-bearing node types that appear as children of a command node.
 */
const ARGUMENT_NODE_TYPES = new Set([
    "word",
    "string",
    "raw_string",
    "number",
    "simple_expansion",
    "expansion",
    "concatenation",
    "command_name",
]);

function isArgumentNode(node: Node): boolean {
    return ARGUMENT_NODE_TYPES.has(node.type);
}

/**
 * Extract the raw argument tokens from a command-ish AST node.
 * The first token is the command name, followed by its arguments.
 */
function extractArgs(node: Node): string[] {
    const args: string[] = [];

    if (node.type === "negated_command") {
        // ! <command> — recurse into the actual command.
        for (const child of node.children) {
            if (isCommandLeaf(child.type) || child.type === "command") {
                return extractArgs(child);
            }
        }
        return args;
    }

    for (const child of node.children) {
        if (child.type === "command_name") {
            // command_name's own child word holds the name; command_name.text
            // is also the name, so use it directly.
            args.push(child.text);
        }
        else if (isArgumentNode(child)) {
            args.push(child.text);
        }
    }

    return args;
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
        case "list":
        case "logical_expression":
        case "pipeline": {
            // Recurse into the tree-sitter-identified command/container children.
            // We do not skip separator nodes manually; we only follow the
            // command-bearing branches.
            for (const child of node.children) {
                if (isCommandNode(child)) {
                    commands.push(...extractTopLevelCommands(child));
                }
            }
            break;
        }

        case "command":
        case "declaration_command":
        case "negated_command":
        case "test_command": {
            commands.push({
                argString: normalizeCommandText(node.text),
                args: extractArgs(node),
                isComplex: isComplexCommand(node),
            });
            break;
        }

        case "redirected_statement": {
            // A redirected_statement can wrap either a single command with
            // redirections (e.g., `cat > file`, `cat > >(cmd)`, `cat <<EOF`) or
            // a list/pipeline/logical expression (e.g., `cd /a && echo 2>&1`).
            // For a single command, keep the whole statement as one command so
            // complex redirects (process substitution, heredoc) are preserved.
            // For a list, descend into the inner structure and append the
            // redirections to the last extracted command.
            let innerNode: Node | null = null;
            const redirects: string[] = [];

            for (const child of node.children) {
                if (
                    child.type === "file_redirect"
                    || child.type === "heredoc_redirect"
                    || child.type === "herestring_redirect"
                ) {
                    redirects.push(child.text);
                }
                else if (isCommandNode(child)) {
                    innerNode = child;
                }
            }

            if (innerNode && isCommandLeaf(innerNode.type)) {
                commands.push({
                    argString: normalizeCommandText(node.text),
                    args: extractArgs(innerNode),
                    isComplex: isComplexCommand(node),
                });
            }
            else if (innerNode && isContainerNode(innerNode.type)) {
                const innerCommands = extractTopLevelCommands(innerNode);

                if (innerCommands.length > 0 && redirects.length > 0) {
                    const lastCommand = innerCommands[innerCommands.length - 1]!;
                    const redirectText = " " + redirects.map(r => normalizeCommandText(r)).join(" ");
                    lastCommand.argString = normalizeCommandText(lastCommand.argString + redirectText);
                }

                commands.push(...innerCommands);
            }
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
            commands.push({
                argString: normalizeCommandText(node.text),
                args: extractArgs(node),
                isComplex: true,
            });
            break;
        }

        // Unknown/unhandled node types are ignored. We rely on tree-sitter's
        // structure to find the command-bearing nodes.
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
 * @returns ParseResult with top-level commands (each carrying `isComplex`), or "error"
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

        return {
            kind: "commands",
            commands: extractTopLevelCommands(tree.rootNode),
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
