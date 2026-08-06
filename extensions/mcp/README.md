# MCP — Model Context Protocol for pi

Lets pi act as an **MCP client**: it connects to external MCP servers, discovers
their tools, and exposes them to the agent as normal pi tools. It also adds
helper tools for MCP **resources** and **prompts**.

Built on the official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
(TypeScript), so protocol-level behaviour — including OAuth — is handled by the SDK.

> SSE transport is deprecated in the MCP spec and is **not** supported. Only
> **stdio** and **streamable HTTP** servers are supported, which is the modern,
> recommended combo.

## Features

- **Transports**: `stdio` (local processes) and `http` (streamable HTTP).
- **OAuth** (full):
  - Interactive **authorization-code** flow (RFC 8252) — opens your browser to a
    `127.0.0.1` loopback, handles the PKCE exchange, and persists credentials.
  - **client_credentials** grant for machine-to-machine auth.
  - **Static bearer tokens** for simple servers.
- **Permission-less credential storage**: OAuth client registrations, access
  tokens, refresh tokens and PKCE verifiers persist per server under
  `~/.pi/agent/mcp/auth/<server>.json`.
- **Resources & prompts**: dedicated helper tools (`mcp_list_resources`,
  `mcp_read_resource`, `mcp_list_prompts`, `mcp_get_prompt`).
- Server instructions are surfaced to the model via each tool's description.

## Configuration

Servers are read, in order:

1. `<project>/.mcp.json`
2. `<project>/mcp.json`
3. `~/.mcp.json`  (global — fills in any server not defined above)

The file follows the standard `mcpServers` shape (the same as Claude Code /
desktop configurations).

### stdio server

```json
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github", "github-token"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
    }
  }
}
```

`${VAR}` placeholders in `command`/`args`/`env` are expanded from the environment.
Set `cwd` to change the spawn working directory.

### HTTP server (streamable HTTP)

```json
{
  "mcpServers": {
    "my-server": {
      "type": "http",
      "url": "https://example.com/mcp",
      "auth": "authorization_code",
      "headers": { "X-Client": "pi" }
    }
  }
}
```

### Auth options

| `auth`             | What it does                                                        |
| ------------------ | ------------------------------------------------------------------- |
| `authorization_code` (default) | Interactive browser OAuth flow. Open your browser, authorize, done. |
| `client_credentials`          | Uses `clientId`/`clientSecret` with the `client_credentials` grant. |
| `none`            | No auth. Unknown |
| *(static token)*   | Provide `token` to send a static `Authorization: Bearer` header.    |

For `client_credentials`:

```json
{
  "mcpServers": {
    "svc": {
      "type": "http",
      "url": "https://example.com/mcp",
      "auth": "client_credentials",
      "clientId": "my-id",
      "clientSecret": "${MCP_CLIENT_SECRET}"
    }
  }
}
```

## Usage inside pi

Auto-connects on session start and registers every discovered tool as
`mcp__<server>__<tool>` — the same format Claude Code uses for MCP permission
rules (e.g. an `add` tool from server `test-server` becomes
`mcp__test-server__add`). Configure a custom prefix per-server with `toolPrefix`.

| Command                  | Effect                                          |
| ------------------------ | ----------------------------------------------- |
| `/mcp`                   | Show connection status.                         |
| `/mcp connect [<server>]` | Connect/disconnect all or one server.           |
| `/mcp reconnect <server>` | Re-authenticate (triggers OAuth when needed). |
| `/mcp disconnect <server>`| Tear down a server's connection.                |
| `/mcp tools <server>`    | Count of tools exposed by a server.             |
| `/mcp config`            | List the resolved server configuration.         |

### TUI helper tools (the LLM may call these)

- `mcp_list_resources(server)` — list resources.
- `mcp_read_resource(server, uri)` — read a resource by URI.
- `mcp_list_prompts(server)` — list prompt templates.
- `mcp_get_prompt(server, name, { args })` — resolve a prompt.

## Layout

```
extensions/mcp/
├── index.ts          # entry point: wires events, command, and helper tools
├── config.ts        # config discovery & parsing
├── registry.ts      # client registry: connect, discover, register, call
├── oauth.ts         # OAuth providers + loopback callback server + storage
├── jsonSchema.ts    # MCP JSON Schema -> TypeBox conversion
├── format.ts        # serializes CallToolResult into text
├── commands.ts      # /mcp command + resource/prompt helper tools
└── __fixtures__/    # tiny MCP server used by the tests
```

## Tests

```bash
bun test extensions/mcp/
```

The registry test spins up a real stdio MCP server and verifies the full
connect → discover → register → call round-trip.