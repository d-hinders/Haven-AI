---
owner: "@d-hinders"
status: current
contract: true
covers:
  - packages/mcp/**
  - packages/connect/**
  - packages/signer/**
  - packages/mcp-server/src/tools.ts
  - .github/workflows/publish.yml
last-verified: "2026-08-10" # 0.1.19 train: #1254 (version table), #1255 (typed_data_b64 additive on both MCP surfaces) and #1256 (window margin) all re-verified — manifest, Node floor and release checklist unchanged
---

# MCP Runtime Compatibility

> **Scope:** This covers the **local stdio MCP runtime** installed during agent
> setup — the advanced/local path. For the default topology (hosted MCP + local
> signer) and how to deploy it, see [hosted-mcp.md](hosted-mcp.md).
>
> **Two sections sit outside that scope**, each for its own reason:
>
> - [Where the Node floor is enforced](#where-the-node-floor-is-enforced) applies
>   to **both** topologies. The floor is a property of the machine, not of the
>   chosen topology — scoping it to the local path is exactly the mistake
>   [#1161](https://github.com/d-hinders/Haven-AI/issues/1161) fixed, so it is
>   documented in one place rather than split across two.
> - [Signer / hosted-MCP version skew](#signer--hosted-mcp-version-skew-1138-1143)
>   and its [pre-payment detection](#detecting-skew-before-a-payment-1155)
>   subsection are the **opposite** case: they apply only to the hosted MCP +
>   local signer topology, because skew needs two independently versioned
>   components and the local runtime signs in-process with the SDK it shipped
>   with. They live here because this is the runtime-compatibility doc, not
>   because they describe the local path.

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
| `@haven_ai/connect` | `0.1.19-alpha.0` |
| `@haven_ai/mcp` | `0.1.19-alpha.0` |
| `@haven_ai/sdk` | `0.1.19-alpha.0` |
| `@haven_ai/signer` | `0.1.19-alpha.0` |
| Codex Desktop / Codex CLI | local stdio MCP via `~/.codex/config.toml` |
| Claude Code | local stdio MCP via `claude mcp add-json --scope user` |

## Where the Node floor is enforced

`>=24.0.0` is declared in four places that must agree: the `engines.node` of the
four packages this floor governs (`sdk`, `connect`, `signer`, `mcp`), `.nvmrc`,
`HAVEN_MINIMUM_NODE_VERSION` in `@haven_ai/sdk`, and
`MCP_RUNTIME_MANIFEST.minimumNodeVersion`. The manifest field is **derived** from
the SDK constant, and a guard test in each of those four packages pins its own
`engines.node` to it. They cannot drift silently.

They did drift once, which is why the constant exists. `engines` said `>=24`
everywhere while the manifest enforced `20.0.0`, so the guard meant to hold the
floor passed Node v23 — and because that guard only ran inside local-MCP
installation, the **default** (hosted MCP + local signer) path never called it at
all. A full connect on Node v23.1.0 completed, installed the signer, and produced
a real testnet payment signature ([#1161](https://github.com/d-hinders/Haven-AI/issues/1161)).

`@haven_ai/cli` is **out of scope and declares no `engines` floor today** — it is
published but sits outside the connect/signer/MCP runtime this section governs.
Neither do the unpublished workspace packages (`backend`, `frontend`, `core`,
`mcp-server`, `demo-merchant-mcp`, `qa-agent`), which are pinned by `.nvmrc` in
CI instead. Read "the floor" here as the agent-runtime floor, not a repo-wide one.

Enforcement now happens at three points, all refusing rather than warning:

| Point | What refuses | Why there |
| --- | --- | --- |
| `runConnect` (every topology) | Setup, before the setup token is resolved, credentials are written, or an agent is registered | A failed precondition must not strand a half-created agent or burn a one-shot token |
| `prepareLocalMcpRuntime` | The `--local` install | Kept; it is the deeper of the two connect paths |
| `runSignerStdioServer` / `runStdioServer` | Startup, before credentials are read | Install-time checks cannot see a Node **downgrade** after setup, or a version manager handing the agent runtime a different Node than the shell that connected |

Refusing rather than warning is deliberate. `engines` alone is advisory — npm
prints `EBADENGINE` and installs anyway unless the user runs `engine-strict` — so
before this the floor held by luck. And what gets installed is the **signer**,
which holds the delegate key and produces every payment signature; on an
unsupported runtime the plausible failure is a wrong or missing signature. "It
seemed to work" is exactly the evidence that cannot be trusted there.

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

### Detecting skew before a payment (#1155)

Every row above is a *post-quote* symptom: the agent found out by trying to pay.
The same skew is now detectable at connection time, from two surfaces that cost
nothing to read.

| Surface | What it states | Where |
|---|---|---|
| Signer `initialize` result | The version sets this signer will verify — `capabilities.experimental["haven/signer-compatibility"]` (machine-readable) and the same numbers in `instructions` (what clients show the model) | `packages/signer/src/capabilities.ts`, wired in `buildSignerMcpServer` |
| Hosted quote/prepare result | `signer_compatibility.x402_expected_context_version` — the version that quote will emit — plus the comparison instruction in-band | `packages/mcp-server/src/tools.ts` (`haven_pay_x402_quote`, `haven_pay_mcp_tool`) |

**The check is agent-mediated, and cannot be otherwise.** The signer and the
hosted MCP are two separate servers connected to the same agent client. The
hosted server cannot introspect the signer, and the signer never calls the Haven
API — it only signs. Only the agent sees both handshakes, so what ships is the
information plus the prompt to compare it. The hosted tool descriptions carry
that prompt; the signer's `instructions` carry the other half.

**A mismatch warns, it does not block** (owner decision, 2026-08-07). No refusal
was added to the payment path: a quote whose emitted version the signer may not
know still succeeds and simply reports the number. Refusing on the strength of
reported client metadata would let a false positive block a working payment,
which is strictly worse than the reactive state — and the signing-time guard
above already fails closed, so nothing is unguarded. Both surfaces name the same
fix (update `@haven_ai/signer`; rerun `npx @haven_ai/connect@alpha`), so an agent
that meets either says the same thing to the user.

The advertised set is **derived** from `SUPPORTED_X402_EXPECTED_VERSIONS` /
`SUPPORTED_SWEEP_BINDING_VERSIONS`, never a second literal — including the
rendered numbers inside `instructions`. Drift between what is advertised and what
is enforced is the one way this feature could become a lie, so tests hold them
together in both directions: a handshake assertion pins the advertised sets to
the exported constants, and a behavioural test drives the real signing path with
every advertised version and fails if the skew guard rejects any of them.

The signer advertises under `capabilities.experimental` rather than the newer
`extensions` field on purpose. Both are `Record<string, object>` in
`@modelcontextprotocol/sdk@1.29`, but a client running an older SDK parses the
`initialize` result with a `ServerCapabilities` schema that has no `extensions`
key and would strip it — and an out-of-date client is exactly the population this
feature serves.

Adding a read-only capability *tool* was the documented fallback if the SDK could
not carry this at handshake. It can (`ServerOptions.capabilities` and
`ServerOptions.instructions`, both forwarded by `McpServer` into the `initialize`
result), and a new tool would have been worse than redundant: the signer's
consent hash is computed over its registered tool names, so adding one would
invalidate every existing acknowledgement and prompt users to re-consent for a
diagnostic.

This covers the **hosted MCP + local signer** topology only. The local
`@haven_ai/mcp` runtime signs in-process with the SDK it was installed with, so
there is no second component to be out of step with.

## Troubleshooting

- **A stale local `dist/` masquerading as version skew (#1188).** The symptoms
  in the skew table above have a second, unrelated cause: a sibling package
  whose `dist/` is older than its `src/`. `packages/signer`'s dist once sat four
  weeks behind its source and produced
  `signX402FundingTypedData is not a function` plus a pre-#1143 schema rejecting
  `auth.version` — indistinguishable, from the error alone, from a genuinely
  outdated installed signer. The npm scripts rebuild what they depend on
  (`npm run test -w packages/mcp-server` builds sdk and signer first), so this
  only bites when vitest is invoked directly. A `globalSetup` guard now refuses
  to run those suites against a stale dist, and `npm run check:dist` reports it
  on demand. If you see a skew-shaped error locally, check this before
  reinstalling anything.
- **Broken or root-owned `~/.npm`:** the MCP runtime install first tries the
  user's default npm cache with `--prefer-offline` (which `npx` just warmed, so
  the signer/sdk tarballs are reused instead of re-downloaded). If that fails —
  e.g. a corrupted or root-owned global cache — it automatically retries against
  the isolated `~/.haven/npm-cache`, so a broken global cache still cannot break
  normal agent startup.
- **Invalid Codex TOML:** the connector writes Codex config with a TOML string
  serializer and validates the generated Haven block before writing. The
  expected shape is `command = ".../bin/haven-mcp"` and `args = []`.
- **Unsupported Node.js:** the connector, signer, and MCP packages require
  Node.js `>=24.0.0`, and
  since [#1161](https://github.com/d-hinders/Haven-AI/issues/1161) setup
  **refuses** below it rather than proceeding — see
  [Where the Node floor is enforced](#where-the-node-floor-is-enforced). The
  message names your version and how to upgrade. Upgrade Node and rerun setup.
  If setup succeeded but the signer now refuses to start, the runtime launching
  it is on an older Node than the shell you upgraded.
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
