// ============================================================================
// Bash Command Parser (Tree-Sitter Implementation)
// ============================================================================
//
// Parses bash commands using tree-sitter for robust parsing.
// Replaces the custom 540-line tokenizer with tree-sitter-bash grammar.
//
// Handles: pipes, ;, &&, ||, &, newlines, $(…), `…`, (…) subshells,
// find -exec, and redirections.
//
// For "difficult" cases (process substitution, heredocs, unterminated quotes),
// returns { kind: "complex" } so the caller can fall back to asking the user.

import { Parser, Language } from "web-tree-sitter";
import { fileURLToPath } from "url";
import path from "path";

// ============================================================================
// Types
// ============================================================================

export interface LeafCommand {
  /** The reconstructed arg string for this command (cmd + args, minus redirections) */
  argString: string;
}

// Alias for backward compatibility with tests
export type ParsedCommand = LeafCommand;

export type ParseResult =
  | { kind: "commands"; commands: LeafCommand[] }
  | { kind: "complex" };

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
      
      let bashLanguage: any = null;
      try {
        bashLanguage = await Language.load(wasmPath);
      } catch (e: any) {
        throw new Error(
          `Failed to load tree-sitter-bash.wasm from ${wasmPath}: ${e?.message || e}`
        );
      }

      if (!bashLanguage) {
        throw new Error("Could not find tree-sitter-bash.wasm in any expected location");
      }

      parser.setLanguage(bashLanguage);
      parserInstance = parser;
    } catch (error) {
      console.error("Failed to initialize tree-sitter parser:", error);
      // Keep parserInstance as null so we fall back to complex
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
// AST Walking: Extract commands from tree-sitter nodes
// ============================================================================

interface ExtractedCommand {
  argString: string;
}

/**
 * Recursively extract all leaf commands from AST node.
 */
function extractCommands(node: any): ExtractedCommand[] {
  const commands: ExtractedCommand[] = [];

  // Handle different node types
  switch (node.type) {
    case "program":
      // Process all children
      for (const child of node.children) {
        commands.push(...extractCommands(child));
      }
      break;

    case "command":
      // Simple command - extract argString
      commands.push(extractSimpleCommand(node));
      break;

    case "pipeline":
      // Pipe-separated commands (cmd1 | cmd2 | cmd3)
      for (const child of node.children) {
        if (child.type !== "|") {
          commands.push(...extractCommands(child));
        }
      }
      break;

    case "command_list":
      // ;-separated commands (cmd1; cmd2; cmd3)
      for (const child of node.children) {
        if (child.type !== ";") {
          commands.push(...extractCommands(child));
        }
      }
      break;

    case "logical_expression":
      // && or || separated commands (cmd1 && cmd2 || cmd3)
      for (const child of node.children) {
        if (child.type !== "&&" && child.type !== "||") {
          commands.push(...extractCommands(child));
        }
      }
      break;

    case "subshell":
      // Parenthesized command list: (cmd1; cmd2)
      for (const child of node.children) {
        if (child.type !== "(" && child.type !== ")") {
          commands.push(...extractCommands(child));
        }
      }
      break;

    case "command_substitution":
      // $(...) or `...`
      for (const child of node.children) {
        if (child.type !== "$(" && child.type !== ")" && child.type !== "`") {
          commands.push(...extractCommands(child));
        }
      }
      break;

    case "variable_assignment":
      // Skip variable assignments (VAR=value)
      break;

    case "redirected_statement":
      // Command with redirections - extract the command part
      for (const child of node.children) {
        if (child.type === "command" || 
            child.type === "pipeline" || 
            child.type === "command_list" ||
            child.type === "logical_expression") {
          commands.push(...extractCommands(child));
        }
      }
      break;

    default:
      // For unknown types, recursively process children
      for (const child of node.children) {
        commands.push(...extractCommands(child));
      }
  }

  return commands;
}

/**
 * Extract argString from a simple command node.
 * Includes all named children except redirections.
 */
function extractSimpleCommand(node: any): ExtractedCommand {
  const parts: string[] = [];
  
  for (const child of node.children) {
    // Skip redirections
    if (child.type === "file_redirect" || 
        child.type === "heredoc_redirect" ||
        child.type === "heredoc_body" ||
        child.type === "heredoc_start") {
      continue;
    }
    
    // Include all named nodes (command_name, word, number, string, raw_string, etc.)
    if (child.isNamed) {
      parts.push(child.text);
    }
  }
  
  return { argString: parts.join(" ") };
}

// ============================================================================
// Special Case Handling
// ============================================================================

/**
 * Post-process commands to handle find -exec and other special cases.
 */
function postProcessCommands(commands: ExtractedCommand[]): ExtractedCommand[] {
  const result: ExtractedCommand[] = [];
  
  for (const cmd of commands) {
    const tokens = cmd.argString.split(/\s+/);
    
    // Handle find -exec
    if (tokens[0] === "find") {
      const execIdx = tokens.findIndex(
        (t, i) => i > 0 && (t === "-exec" || t === "-execdir")
      );
      
      if (execIdx !== -1) {
        // Extract the exec command
        const execTokens: string[] = [];
        for (let i = execIdx + 1; i < tokens.length; i++) {
          if (tokens[i] === ";" || tokens[i] === "\\;") break;
          execTokens.push(tokens[i]);
        }
        
        if (execTokens.length > 0) {
          result.push({ argString: execTokens.join(" ") });
        }
        
        // Also add the find command itself (up to -exec)
        const findTokens = tokens.slice(0, execIdx);
        result.push({ argString: findTokens.join(" ") });
        continue;
      }
    }
    
    // Regular command
    result.push(cmd);
  }
  
  return result;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Parse a bash command string using tree-sitter.
 * 
 * @param input - The bash command string to parse
 * @returns ParseResult with extracted leaf commands, or "complex" if parsing fails
 */
export function parseBashCommand(input: string): ParseResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { kind: "commands", commands: [] };
  }

  // If parser not initialized, fall back to complex
  if (!parserInstance) {
    console.warn("Tree-sitter parser not initialized, returning complex");
    return { kind: "complex" };
  }

  try {
    // Parse the input
    const tree = parserInstance.parse(trimmed);
    
    // Check for errors that indicate "complex" cases
    // Tree-sitter will parse even invalid input, so we need to check for ERROR nodes
    if (hasErrorNode(tree.rootNode)) {
      return { kind: "complex" };
    }

    // Check for process substitution, heredoc, or command substitution (should be "complex")
    if (hasProcessSubstitution(tree.rootNode) || hasHeredoc(tree.rootNode) || hasCommandSubstitution(tree.rootNode)) {
      return { kind: "complex" };
    }

    // Extract all leaf commands
    const commands = extractCommands(tree.rootNode);
    
    // Post-process for special cases (find -exec, etc.)
    const processedCommands = postProcessCommands(commands);
    
    return {
      kind: "commands",
      commands: processedCommands,
    };
  } catch (error) {
    // If parsing fails for any reason, fall back to "complex"
    console.error("Error parsing bash command:", error);
    return { kind: "complex" };
  }
}

/**
 * Check if the AST contains an ERROR node (indicates syntax error).
 */
function hasErrorNode(node: any): boolean {
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

/**
 * Check if the AST contains process substitution <() or >().
 */
function hasProcessSubstitution(node: any): boolean {
  if (node.type === "process_substitution") {
    return true;
  }
  for (const child of node.children) {
    if (hasProcessSubstitution(child)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if the AST contains a heredoc.
 */
function hasHeredoc(node: any): boolean {
  if (node.type === "heredoc_redirect" || 
      node.type === "heredoc_body" ||
      node.type === "heredoc_start") {
    return true;
  }
  for (const child of node.children) {
    if (hasHeredoc(child)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if the AST contains a command substitution $(...) or `...`.
 */
function hasCommandSubstitution(node: any): boolean {
  if (node.type === "command_substitution") {
    return true;
  }
  for (const child of node.children) {
    if (hasCommandSubstitution(child)) {
      return true;
    }
  }
  return false;
}
