# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## Project Overview

Pi coding agent extension project containing ten extensions and shared utilities. Extensions are registered via `pi.extensions` in package.json. No build step — raw TypeScript is loaded directly by Pi's extension system (`tsconfig.json` has `"noEmit": true`).

## Extensions

- `extensions/tool-permissions` — Intercepts tool calls and checks permissions against claude settings files
- `extensions/ask-user-questions` — Custom TUI component for asking users multiple-choice questions
- `extensions/subagent` — Spawns separate `pi` processes as specialized subagents with isolated context
- `extensions/webfetch` — Fetches URLs, converts HTML→markdown via turndown, sanitizes through an isolated pi session
- `extensions/websearch` — Web search via Ollama's API
- `extensions/my-theme` — Custom theme with header, footer (cwd, git branch, context usage, model info), and arrow prompt editor component
- `extensions/file-rollback` — Snapshots working directory state via a shadow git repo (`~/.pi/agent/file-rollback/<projectHash>/.git`), supports rolling back via `/tree`
- `extensions/session-namer` — Auto-names sessions using a small dedicated model via a temporary isolated session
- `extensions/plan` — `/plan [prompt]` plan mode: read-only session (read, bash allowlist, WritePlan/EditPlan) that writes a plan to `.pi/plans/<name>.md`, renders it, and prompts to implement (new session / same session) or update
- `extensions/mcp` — MCP client: connects pi to external MCP servers (stdio + streamable HTTP) via the `@modelcontextprotocol/sdk`, exposing their tools/resources/prompts as pi tools, with full OAuth support
- `extensions/shared/` — Reusable utilities:
  - `bash-parser` — Tree-sitter based bash command parser (requires WASM initialization via `initParser()`)
  - `tui-components` — Reusable TUI components (`PermissionSelector`, `InlineInput`, `NoInputInline`)
  - `config-helpers` — Path helpers for claude config file locations
  - `jsonc-utils` — Strips JSONC comments
  - `pattern-matching` — Glob-style pattern matching with domain filtering support
  - `web-content-cache` — Caches fetched web content
  - `utils/` — General shared utilities
  - `test/` — Shared test utilities

## Development

- Package manager and runtime: Bun (`bun` is also a dependency for Bun APIs)
- Language: TypeScript 6 with strict mode, verbatim module syntax, ESM (`"type": "module"`)
- Run tests: `bun test`
- Lint: `npx eslint --fix`
- Type check: `npx tsc --noEmit`
- Tests use `bun:test` (`import { describe, test, expect, beforeAll } from "bun:test"`)
- Tests use `beforeAll` for async initialization (e.g., tree-sitter parser)
- No explicit npm scripts in package.json — use the commands above directly

## Code Conventions

- Extension entry points export a default function that receives `ExtensionAPI`
- Register tools via `pi.registerTool()` with TypeBox schemas for parameters
- Hook into events via `pi.on("event_name", handler)` (e.g., `session_start`, `tool_call`)
- Tools provide `renderCall` and `renderResult` functions for custom TUI rendering
- Custom UI via `ctx.ui.custom()` for interactive components
- Tree-sitter parser must be initialized before use — call `await initParser()` in `beforeAll` for tests
- Use `import type` for type-only imports
- 4-space indent, double quotes, semicolons, JSX enabled
- Imports must be sorted (`simple-import-sort` plugin enforces this)
- `noUncheckedIndexedAccess` is enabled — access potentially-undefined array/map indices with care

## Tool Permissions

- `find` and `ls` map to the `bash` permission category; `edit` and `write` map to `edit`
- Subagent permissions are merged last via `PI_SUBAGENT_PERMISSIONS_FILE`; precedence within merges is deny > ask > allow
- Project-local subagents require user confirmation when the project isn't trusted
