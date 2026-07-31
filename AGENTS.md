# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## Project Overview

Pi coding agent extension project containing two extensions and shared utilities. Extensions are registered via `pi.extensions` in package.json.

## Extensions

- `extensions/tool-permissions` — Intercepts tool calls and checks permissions against claude/opencode settings files
- `extensions/ask-user-questions` — Custom TUI component for asking users multiple-choice questions
- `extensions/shared/` — Reusable utilities:
  - `bash-parser` — Tree-sitter based bash command parser (requires WASM initialization via `initParser()`)
  - `tui-components` — Reusable TUI components
  - `config-helpers` — Configuration utilities
  - `jsonc-utils` — JSONC parsing
  - `pattern-matching` — Pattern matching utilities

## Development

- Runtime: Bun (see CLAUDE.md for Bun-specific conventions)
- Language: TypeScript with strict mode, verbatim module syntax
- Run tests: `bun test`
- Tests use `beforeAll` for async initialization (e.g., tree-sitter parser)

## Code Conventions

- Extension entry points export a default function that receives `ExtensionAPI`
- Tree-sitter parser must be initialized before use — call `await initParser()` in `beforeAll` for tests
