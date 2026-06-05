# MCP Runtime Compatibility

Haven Connect Agent 2 installs a local stdio MCP runtime for Codex Desktop,
Codex CLI, and Claude Code. The connector must not rely on `npx` at agent
startup; setup preinstalls a tested runtime and writes a stable wrapper:

```text
~/.haven/agents/<agent-id>/bin/haven-mcp
```

## Supported Runtime Manifest

The source of truth is `packages/connect/src/runtime-manifest.ts`.

| Component | Supported version |
| --- | --- |
| Node.js | >= 20.0.0 |
| `@haven_ai/connect` | current package version |
| `@haven_ai/mcp` | `0.1.4-alpha` |
| `@haven_ai/sdk` | `0.1.6` |
| `@haven_ai/signer` | `0.1.0-alpha` |
| Codex Desktop / Codex CLI | local stdio MCP via `~/.codex/config.toml` |
| Claude Code | local stdio MCP via `claude mcp add-json --scope user` |

## Release Checklist

- Update `packages/connect/src/runtime-manifest.ts` whenever `connect`, `mcp`,
  `sdk`, or `signer` compatibility changes.
- Keep `packages/connect/package.json` and `packages/mcp/package.json` pinned
  to the tested SDK/runtime versions; do not use wildcard dependencies.
- Run `npm run test -w packages/connect` before publishing connector or MCP
  packages. CI runs connector tests whenever SDK, MCP, signer, or connector
  files change.
- Run `npm run smoke:pack -w packages/connect` before publishing connector or
  MCP packages. The smoke packs local SDK/MCP artifacts, stages them into a
  temp Haven runtime, and verifies the wrapper can complete an MCP `initialize`
  + `tools/list` handshake.
- Verify the generated wrapper with an MCP `initialize` + `tools/list`
  handshake before setup reports local MCP as ready.
- Confirm setup output, logs, generated config, wrapper scripts, and sidecars do
  not include API keys or delegate private keys.

## Troubleshooting

- **Broken or root-owned `~/.npm`:** setup uses `~/.haven/npm-cache` for the MCP
  runtime install, so a corrupted global npm cache should not break normal
  agent startup.
- **Invalid Codex TOML:** the connector writes Codex config with a TOML string
  serializer and validates the generated Haven block before writing. The
  expected shape is `command = ".../bin/haven-mcp"` and `args = []`.
- **Unsupported Node.js:** local MCP setup requires Node.js `>=20.0.0`. Upgrade
  Node and rerun the setup command.
- **Local MCP runtime install failed:** rerun the setup command. It will reuse
  local credentials, install the pinned runtime into `~/.haven/mcp-runtime`, and
  use `~/.haven/npm-cache` rather than the user's global npm cache.
- **Claude Code does not show Haven:** run `claude mcp get haven` and confirm
  it points at the wrapper path. If `add-json` is unavailable, the connector
  falls back to `claude mcp add --scope user -- <wrapper>`.
- **Tools missing after restart:** rerun the connector. It will reuse the
  existing local credentials, reinstall or reuse the pinned MCP runtime, and
  fail loudly if the wrapper handshake cannot list the required Haven tools.
- **Credential safety:** private signing keys live only in
  `~/.haven/agents/<agent-id>/signer.json`. Do not paste signer files, wrapper
  sidecars, or command output into public issues without redacting secrets.
