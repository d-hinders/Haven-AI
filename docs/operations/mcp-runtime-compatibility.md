---
owner: "@d-hinders"
status: current
contract: true
covers:
  - packages/mcp/**
  - packages/connect/**
  - packages/signer/**
  - .github/workflows/publish.yml
last-verified: "2026-08-07"
---

# MCP Runtime Compatibility

> **Scope:** This covers the **local stdio MCP runtime** installed during agent
> setup — the advanced/local path. For the default topology (hosted MCP + local
> signer) and how to deploy it, see [hosted-mcp.md](hosted-mcp.md).

Haven Connect Agent 2 installs a local stdio MCP runtime for Codex Desktop,
Codex CLI, and Claude Code. The connector must not rely on `npx` at agent
startup; setup preinstalls a tested runtime and writes a stable wrapper:

```text
~/.haven/agents/<agent-id>/bin/haven-mcp
```

## Supported Runtime Manifest

The source of truth is `packages/connect/src/runtime-manifest.ts` (the SDK and
signer versions are pinned there; `@haven_ai/mcp` tracks its own `MCP_VERSION`).
Keep this table in sync with that file.

| Component | Supported version |
| --- | --- |
| Node.js | >= 24.0.0 (pinned to LTS 24 in `.nvmrc` / package `engines`) |
| `@haven_ai/connect` | `0.1.18-alpha.0` |
| `@haven_ai/mcp` | `0.1.18-alpha.0` |
| `@haven_ai/sdk` | `0.1.18-alpha.0` |
| `@haven_ai/signer` | `0.1.18-alpha.0` |
| Codex Desktop / Codex CLI | local stdio MCP via `~/.codex/config.toml` |
| Claude Code | local stdio MCP via `claude mcp add-json --scope user` |

## Release Checklist

> Publishing itself is automated: `npm run release:bump -- <version>` produces
> the bump, and merging that to `main` triggers the **Publish packages**
> workflow (`.github/workflows/publish.yml`), which builds and publishes the
> changed packages. Do not run `npm publish` by hand. See
> [`scripts/README.md`](../../scripts/README.md) and the README's
> [Releasing npm packages](../../README.md#releasing-npm-packages) section. The
> checks below still matter — they are what CI enforces on the release PR
> before merge.

- Each published package needs its **own npm trusted publisher** (repo
  `d-hinders/Haven-AI`, workflow `publish.yml`) and a `repository` block in its
  `package.json` — configured once, per package, before its first release.
  `@haven_ai/cli` shipped without either and its first workflow publish failed
  with `E404` (#1159); the publish loop now attempts every package and reports
  per-package outcomes, but the npm-side configuration is an operator step no
  code change can do.
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

## Signer / hosted-MCP version skew (#1138, #1143)

`haven_sign` and `haven_sign_x402` take an optional `typed_data`, and the
x402 expected context has a second version that carries `typedDataHash`. Both
additions are backward compatible in the only direction that can actually occur
— a **v1** (legacy-rail) context is byte-identical to what shipped before, so an
older signer keeps verifying it — but the delegation rail needs both halves
current, and the failure mode differs by which half is stale:

| Stale half | Symptom |
|---|---|
| Signer older than the backend, **`@haven_ai/signer` ≥ the #1143 release** | `This signer is out of date: it supports x402 expected context versions up to <N>, and Haven sent version <M>. Update @haven_ai/signer …` |
| Signer older than the backend, **signer predating #1138** | `MCP error -32602: Input validation error: Invalid arguments for tool haven_sign_x402: Invalid literal value, expected 1 at x402_expected.auth.version` |
| Signer with #1138 but predating #1143 (forward-looking — see below) | `… Invalid input at x402_expected.auth.version` — Zod says nothing at all about a failing literal *union* |
| Backend older than the signer | `Refusing to sign typed data under an expected context that does not commit to it` |

All of these fail closed, which is the point: none produces a signature. Treat any
of them on the delegation rail as a version-skew report, not a credential
problem — and note the last is also what a *legacy-rail* intent looks like if
a caller passes `typed_data` that the context never committed to.

**Why three stale-signer rows (#1143).** The second is what the field actually
returned on 2026-08-06, and #1141's original version of this table got it wrong:
it listed `x402 expected context authentication message is invalid`, which is what
the *binding* check produces. That check is never reached — the tool schema pinned
`auth.version` to a literal, so the MCP server rejected the call before any Haven
code ran, and anyone grepping the documented string during an incident found
nothing. #1143 opened the schema and moved the decision into the signer
(`SUPPORTED_X402_EXPECTED_VERSIONS` in `packages/signer/src/core.ts`), which is
the first row. The other two rows stay because they are not historical: every
signer published before that release still behaves this way, and they remain
installed until users update. Both Zod strings were reproduced against `zod/v3`
rather than inferred — note that a failing literal *union* degrades to a bare
`Invalid input`, so the pre-#1143 signer that knows v2 is even less diagnosable
than the older one that reported `expected 1`.

Row three cannot fire on today's traffic and is listed for the next context bump:
a signer carrying #1138 accepts both v1 and v2, so it only breaks once a v3
context ships while that signer is still installed. Row two is the one seen in
the field on 2026-08-06.

If you see either Zod row, **do not** "fix" it by editing `auth.version` to a
supported value. The version is inside the Haven-signed binding message, so
rewriting it invalidates the signature and misrepresents what Haven authorised —
the update is the fix. The same applies to `expected_auth.version` on the sweep
binding, which shares the mechanism (`SUPPORTED_SWEEP_BINDING_VERSIONS`) and will
hit this the first time that binding is versioned.

## Troubleshooting

- **Broken or root-owned `~/.npm`:** the MCP runtime install first tries the
  user's default npm cache with `--prefer-offline` (which `npx` just warmed, so
  the signer/sdk tarballs are reused instead of re-downloaded). If that fails —
  e.g. a corrupted or root-owned global cache — it automatically retries against
  the isolated `~/.haven/npm-cache`, so a broken global cache still cannot break
  normal agent startup.
- **Invalid Codex TOML:** the connector writes Codex config with a TOML string
  serializer and validates the generated Haven block before writing. The
  expected shape is `command = ".../bin/haven-mcp"` and `args = []`.
- **Unsupported Node.js:** local MCP setup requires Node.js `>=24.0.0`. Upgrade
  Node and rerun the setup command.
- **Local MCP runtime install failed:** rerun the setup command. It will reuse
  local credentials and install the pinned runtime into `~/.haven/mcp-runtime`,
  falling back from the user's default npm cache to `~/.haven/npm-cache` if the
  global cache is unusable.
- **Claude Code does not show Haven:** run `claude mcp get haven` and confirm
  it points at the wrapper path. If `add-json` is unavailable, the connector
  falls back to `claude mcp add --scope user -- <wrapper>`.
- **Tools missing after restart:** rerun the connector. It will reuse the
  existing local credentials, reinstall or reuse the pinned MCP runtime, and
  fail loudly if the wrapper handshake cannot list the required Haven tools.
- **Credential safety:** private signing keys live only in
  `~/.haven/agents/<agent-id>/signer.json`. Do not paste signer files, wrapper
  sidecars, or command output into public issues without redacting secrets.
