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
last-verified: "2026-08-21" # #1682: the runtime picker is name-first — the collapsed "AI agent" row is replaced by a flat product-name list, and a new "The picker is name-first" subsection carries the row→modality table, the folded vscode-insiders id, and the temporary --runtime openclaw → other downgrade with its removal condition. Detection precedence, the Node floor, and every skew/manifest claim re-read against the diff and unchanged. Prior: #1672: runtime selection is detection-first — the setup command drops --runtime on command-path runtimes, detection overrides a contradicting hint (notice printed; --runtime-force escape hatch), and no-detection-no-flag refuses before any side effect; new "Runtime selection is detection-first" section documents it. No manifest, tool, capability, or version-skew surface moves. Prior: Release 0.1.28-alpha.0: the Supported Runtime Manifest table is re-pinned to match packages/connect/src/runtime-manifest.ts. Version strings only — no tool, capability, or version-skew surface moves, and the skew contract paragraphs below re-read against the diff stand unchanged. The bump exists because the #1620 SDK decomposition epic (#1614, #1618, #1619, #1631, #1634, #1636, #1655) rewrote packages/sdk/src/client.ts AFTER 0.1.27-alpha.0 was published, and publish.yml skips versions already on npm — so without it the same version string holds different code on npm and in-repo, and the entries below that document that epic would describe an SDK npm does not yet ship. That epic reduced client.ts from ~2500 lines to a compatibility facade over extracted lifecycle modules, exactly the change class that could move a consumer-visible surface silently, so it was MEASURED rather than assumed: the built dist/index.d.ts diffed against the @haven_ai/sdk@0.1.27-alpha.0 tarball from npm shows 155 top-level declarations with zero added and zero removed, and no changed line in the 227-line type diff that is not a private member or a comment. What moved is which module owns a code path, never what a consumer may call. Prior: #1618 re-verify: the SDK's EIP-3009 x402 funding leg moved out of HavenClient into internal modules (x402-protocol.ts / x402-funding-leg.ts). Behaviour-preserving and INTERNAL — no tool schema, capability, runtime-floor, or version-skew surface moves, and the published set this doc governs is unchanged. This doc was pulled in only because connect's package-smoke test had a comment naming the renamed method; every claim here re-read against the diff stands. Prior: Release 0.1.27-alpha.0: the Supported Runtime Manifest table is re-pinned to match packages/connect/src/runtime-manifest.ts. Version strings only — no tool, capability, or version-skew surface moves, and the skew contract paragraphs below re-read against the diff stand unchanged. The bump exists because #1593, #1595, #1597 and #1598 changed connect, the hosted server and the SDK AFTER 0.1.26-alpha.0 was published, and publish.yml skips versions already on npm — so without it `npx @haven_ai/connect@alpha` keeps resolving to a build with no --doctor, and this table's own #1589/#1587/#1588 entries would document a connector that npm does not yet ship. Prior: #1593: the LOCAL MCP runtime install is hardened like #1586 did the signer's — same honest budget (SIGNER_INSTALL_TIMEOUT_MS, replacing the spurious 120s timeout) and 15s onProgress heartbeats, threaded through installRuntime (integration-proven; the unthreaded-callback mutation fails the test). Setup reliability only — no tool, capability, or version-skew surface moves. Prior: #1591: hosted tool-description prose slimmed ~49% with flow-generic guidance consolidated into the server instructions (sign-by-payment_id, settle shapes, expiry re-run, version-mismatch branch, sweep pointer) — prose only; no tool schema, capability, or version-skew surface moves, and the skew contract paragraphs re-read against the diff stand unchanged. Prior: #1590: haven_get_agent gains spend_authority_readiness (readiness stays as a deprecated same-value alias) — additive field + prose stating the local-signer exclusion; no tool schema, capability, or version-skew surface moves. Prior: #1589: --doctor/--repair documented. Prior: #1588: runtime-neutral next_tool_server/next_tool_name pair documented. Prior: #1587: hosted-topology setup handshake-probes the local signer before reporting success; troubleshooting entry added. Prior: #1586: signer preinstall fails closed (no config write, no npx fallback), 10-min budget + heartbeats; troubleshooting entry added. Prior: #1549 re-verify: haven_pay_mcp_tool/haven_prepare_catalog_purchase stop echoing payment_required by default (the signer's #1355 payment_id fetch is the source; include_signing_payload=true restores it — the same replay escape this doc already documents for typed_data), and signer_compatibility.check is shorter prose with the #1309 machine fields unchanged. No tool schema, capability, or version-skew surface moves; the skew table's quote/prepare row and the #1309 contract paragraphs re-read against the diff and stand. Prior: #1548 re-verify: tool-description prose gains the no-user-cap convention (quote first, cap = live quote) — guidance text only; no tool, capability, or version-skew surface moves, and every claim here re-read against the diff stands unchanged. Prior: #1547: the pre-payment skew guidance stops asking agents to compare against the signer's MCP initialize result (unperformable in most harnesses — they cannot see the handshake); the documented protocol is now "sign; branch on the signer's machine-readable version-mismatch refusal (#1309)". Enforcement location unchanged — the signing-time refusal was always the only hard gate; the initialize capability surfaces stay advertised. Also: haven_prepare_catalog_purchase gains the #1450 scheme selection (erc7710 direct settlement when rail+merchant allow; mcpCallContext persisted on that scheme too), so its skew paragraph is scheme-aware now. Prior: #1569: the Claude Code LOCAL-stdio writer now removes stale haven/haven-signer entries before re-adding, mirroring the hosted writer — a second local-stdio setup previously collided on the existing entry and left the runtime wired to the previous agent's wrapper. The troubleshooting advice here ("rerun the connector") becomes reliably true on that path; the add-json → add fallback claim is unchanged. No tool, capability, or version-skew surface moves. Prior: #1545 re-verify: --json discoverability (a one-sentence mention in the dashboard's setup prompt; README documents that structured runs skip the approval wait — matching what this doc already said) and the "approve the budget" gate rename sweep across the setup prompt and dashboard connect-flow copy, converging on the term this doc's handoff section already uses (#1542). Every claim here re-read against the diff and unchanged — no tool, capability, or version-skew surface moves. Prior: #1544 re-verify: characterization tests + a README "Running setup again" section pin connect's re-run behavior (consumed setup fails before any local write; new agent lands in a sibling credential directory; managed MCP entries replaced, never duplicated). Tests and docs only — zero behavior change, and every claim in this doc re-read against the diff stands unchanged. Prior: #1543: the connector sends an early install-status report when the runtime config write settles, so the dashboard's budget-approval unlock stops waiting on probes + skill install; the final report stays authoritative. Readiness-metadata timing only — no tool, capability, or version-skew surface moves. Prior: #1542: the Connect completion handoff is approval-aware — the "Completion handoff after Connect" section is rewritten to match (handoff shaped by the wait's observed outcome; immediate first check before the waiting line; "budget" is the one name for the gate in connector output; restart step carries its why). Output prose and poll timing only — no tool, capability, or version-skew surface moves, and the --json structured outcome is unchanged. Prior: #1521 ships to npm: release 0.1.26-alpha.0 — the Supported Runtime Manifest table is re-pinned to match packages/connect/src/runtime-manifest.ts. Version strings only; no tool, capability, or version-skew surface moves. The bump exists because #1521 changed packages/sdk/src/client.ts AFTER 0.1.25-alpha.0 was published and publish.yml skips versions already on npm — without it, npm's SDK would keep signing EIP-3009 authorizations against a spent delegate on an idempotency replay (the exact defect class the 0.1.25 note below records for #1511). First release under the #1526 pin rules: mcp-server's version bumps in lockstep while its "*" workspace pins are untouched, verified by verifyPrivateConsumersUnpinned at bump time. Prior: #1526: mcp-server and demo-merchant-mcp are now flagged `private: true` with "*" internal pins, matching what the unpublished-workspace-packages list here already said. NO runtime-floor, version-skew, or Supported Runtime Manifest surface moves — the published set this doc governs is unchanged at sdk/signer/mcp/connect/cli, and the connect package-smoke pin check now derives that set from each package's own `private` field instead of a hardcoded list that had drifted in both directions (mcp-server wrongly in, cli wrongly absent and therefore unguarded). Prior: Release 0.1.25-alpha.0: the Supported Runtime Manifest table is re-pinned to match packages/connect/src/runtime-manifest.ts. A version bump only — no tool, capability, or skew-contract surface moves, and the version-skew rules below are unchanged. The bump exists because #1511 changed packages/sdk/src/client.ts AFTER 0.1.24-alpha.0 was published, so that version on npm and in-repo would otherwise hold different code; publish.yml skips versions already on npm, so without a new version the fix never reaches SDK consumers. Prior: #1508 (actual fix): completeX402MerchantCall gains an opt-in no-funding-leg path so a hosted erc7710 settlement reaches the merchant — its readiness gate and mandatory funding-tx hash both encoded the 3009 lifecycle. NO tool schema, capability, or version-skew surface moves: haven_settle_mcp_tool's request/response shapes are byte-identical and 3009 callers take the unchanged path (pinned by a test that a submitted intent without the flag is still refused). Prior #1508: haven_settle_mcp_tool's erc7710 branch no longer runs the funding-confirmation wait — a scheme with no funding leg has no transaction to confirm, and the underlying ensureFundingConfirmed reads GET /payments/:id unconditionally, which 409s on the 'submitted' intent a successful erc7710 settle produces. NO tool schema, capability, or version-skew surface moves: the request and response shapes of haven_settle_mcp_tool are byte-identical, older callers that send payment_header still take the 3009 path unchanged, and nothing here about skew detection or the runtime manifest is affected. A settled payment stops being REPORTED as failed; what may be spent is untouched. Prior: Release 0.1.24-alpha.0 (PR #1503): the Supported Runtime Manifest table is re-pinned to match packages/connect/src/runtime-manifest.ts. A version bump only — no tool, capability, or skew-contract surface moves, and the version-skew rules below are unchanged. Prior: #1469: haven_pay_x402_quote normalizes payment_required — malformed accepts entries now refuse with guidance instead of erroring; valid callers unchanged. #1476: haven_sign now refuses a Delegation-shaped typed_data with no expected context; callers using { payment_id } or haven_sign_x402 are unaffected, and the #1254 direct-payment UserOp path is unchanged. #1456: haven_settle_mcp_tool accepts an OPTIONAL payment_header — its absence selects erc7710. Older callers always send one, so their behaviour is unchanged. #1455 re-verify: the signer gained local caveat verification for erc7710 settlement children — a REFUSAL added, no capability/version surface changed, so nothing here about runtime compatibility or the version-skew contract moves. #1426 re-verify: the connector celebration line now phrases reset periods in the dashboard voice (per week/per month/in total) — output wording only, the completion-handoff ordering and no-secret boundaries here are untouched. #1332: guidance-surface parity — setup installs the canonical skill via each runtime's documented instruction mechanism (Hermes skills dir, Codex global AGENTS.md managed section); Claude Code unchanged. Prior: #1397 hosted-only quote tools.
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

`haven_discover_tools` remains skew-flat across the local and hosted MCP
topologies: since #1350 it accepts the same optional `search` argument on both
surfaces, alongside the existing `category` and `rail` filters. `category`
matching is case-insensitive after trim, `search` matches catalog `name`,
`description`, or `category`, and omitting the new field preserves the older
request shape exactly. The result is still read-only discovery metadata:
catalog prices are indicative hints, never payment authority.

The default hosted MCP + local signer topology additionally exposes
`haven_quote_mcp_tool` and `haven_quote_catalog_purchase` (#1397). They are
read-only live-price probes for an arbitrary MCP merchant or a curated catalog
entry: no payment intent, approval, signing context, allowance check, funding,
or paid retry is created. Their response is informational only; a later hosted
`haven_pay_mcp_tool` or `haven_prepare_catalog_purchase` always obtains a fresh
quote and enforces its own cap before creating an intent. The local stdio MCP
intentionally does **not** expose these tools yet: its current one-shot payment
path cannot honor that quote-then-pay cap/re-quote contract, so publishing the
same names there would imply a safety guarantee it cannot make.

```text
~/.haven/agents/<agent-id>/bin/haven-mcp
```

## Supported Runtime Manifest

The source of truth is `packages/connect/src/runtime-manifest.ts` (the SDK and
signer versions are pinned there; `@haven_ai/mcp` tracks its own `MCP_VERSION`).
Keep this table in sync with that file.

| Component | Supported version |
| --- | --- |
| Node.js | >= 22.0.0 (`engines` floor; repo development and CI pin LTS 24 via `.nvmrc`) |
| `@haven_ai/connect` | `0.1.28-alpha.0` |
| `@haven_ai/mcp` | `0.1.28-alpha.0` |
| `@haven_ai/sdk` | `0.1.28-alpha.0` |
| `@haven_ai/signer` | `0.1.28-alpha.0` |
| Codex Desktop / Codex CLI | local stdio MCP via `~/.codex/config.toml` |
| Claude Code | local stdio MCP via `claude mcp add-json --scope user` |

## Hosted-runtime connector profiles

For the hosted fast-settle path, the local signer may produce either the
supported legacy x402 v1 envelope or the current v2 `{ x402Version, accepted,
payload }` envelope. Hosted MCP validates either recognizable form against the
persisted intent before it relays funding. A malformed, unsupported, expired,
or mismatched header returns `INVALID_PAYMENT_HEADER` with no funding relay;
recreate it through the local signer from the same `payment_id`. This preflight
does not replace merchant or facilitator verification.

The default Connect topology writes a keyless hosted Haven MCP entry plus a
separate local `haven-signer` stdio entry; it is distinct from the local-stdio
runtime described above. Hermes Agent is a supported hosted-runtime profile:
Connect writes `$HERMES_HOME/config.yaml` and its matching owner-only `.env`
when `HERMES_HOME` is set, otherwise `~/.hermes/config.yaml` and `.env`. The
hosted API key stays in `.env`; config uses the `Bearer ${MCP_HAVEN_API_KEY}`
template. Connect preserves source text outside `mcp_servers` and replaces only
the `mcp_servers.haven` and `mcp_servers.haven-signer` entries.
Hermes discovers MCP servers at process startup, so start a new session (or run
`/restart` for a gateway). Hermes also needs its Python MCP SDK installed (`pip
install mcp`) to load MCP tools.

## Runtime selection is detection-first (#1672)

Which runtime's config the connector writes is resolved in
`packages/connect/src/runtime-registry.ts` (`resolveRuntimeSelection`), in this
precedence order:

1. `--runtime-force <name>` always wins (an unknown name refuses, listing the
   valid values).
2. Environment detection (`CLAUDECODE`/`CLAUDE_CODE` → claude-code,
   `CODEX_SANDBOX`/`CODEX_HOME` → codex-cli, `VSCODE_*` → vscode,
   `HERMES_*` → hermes) **beats a contradicting `--runtime` hint**, with a
   printed one-line notice. Detection only fires inside a real agent shell,
   where writing a different client's config is almost surely wrong — the
   failure this closed was a `--runtime claude-desktop` hint pasted into
   Claude Code, which would have configured the Desktop chat app and left the
   Code session with no Haven entries.
3. An explicit `--runtime` with no contradicting detection applies as given —
   the plain-terminal "configure Claude Desktop by hand" case, unchanged.
4. Detection alone.
5. Nothing known → the connector **refuses before any side effect** (the
   #1161 discipline: no half-created agent, no burned setup token), naming
   the valid `--runtime` values.

Accordingly, the dashboard's generated setup command carries **no `--runtime`
flag** for command-path runtimes; snippet-based runtimes keep the flag because
their command runs in a plain terminal where nothing is detectable. The runtime
the connector actually resolved is reported back through the setup status, and
the dashboard's runtime-specific copy keys off that reported value, not the
picker choice. One known detection limit: Codex Desktop's environment detects
as `codex-cli` — both write the same `~/.codex/config.toml`, so the config
lands correctly and only restart phrasing can differ.

### The picker is name-first (#1682)

The dashboard picker is a flat list of **product names**, and which modality a
row produces is a property of the row rather than a question put to the user:

| Picker row | id | Modality |
|---|---|---|
| Claude Code (default) | `claude-code` | command, no `--runtime` |
| Claude Desktop | `claude-desktop` | snippet |
| Codex (CLI or Desktop) | `codex` | command, no `--runtime` |
| Cowork | `cowork` | command, no `--runtime` |
| Cursor | `cursor` | snippet |
| Hermes Agent | `hermes` | snippet + connector-written config |
| OpenClaw | `openclaw` | snippet (`~/.openclaw/openclaw.json`) |
| VS Code (incl. Insiders) | `vscode` | snippet |
| Not listed / other | `other` | manual |

This replaced #1672's single collapsed "AI agent (Claude Code, Codex, Cowork)"
row, which asked the user to classify their own app — a question a Hermes or
OpenClaw user answers "yes, mine is an AI agent" and gets wrong, and which no
user can answer at all when the label never names their harness. The three
command-path rows still produce the **identical** flag-free command; they are
distinct ids only so Haven learns which harnesses people connect from, which
the collapsed `agent` id threw away. `agent` and the legacy per-client ids
(`claude-code`, `codex-cli`, `codex-desktop`) stay accepted on the backend, for
the rollout window and for setup rows created earlier.

Two ids that exist without a row of their own: `vscode-insiders` folds into the
VS Code row (identical config shape and instructions) but is still accepted
wherever ids are validated, and `codex-desktop` is covered by the Codex row.

**`openclaw` is downgraded to `--runtime other` in the generated command**, on
purpose and temporarily. `npx @haven_ai/connect@alpha` resolves to whatever is
published on npm, and an unpublished alias would hit rule 5 above — a refusal
before any side effect, which is right for a value nobody understands and
wrong for a row the dashboard itself offers. Nothing is lost: the connector's
own `openclaw` alias (added in the same change, `runtime-registry.ts`) resolves
to `other` anyway, because "credentials on disk, no auto-written config, paste
the snippet" IS the OpenClaw flow. Remove the downgrade
(`CONNECTOR_FLAG_ALIASES` in `routes/agent-connection-setups.ts`) once a connect
release carrying the alias is on npm.

A consequence of a picker that spans two modalities: pre-run, the dashboard
cannot know which command-path app the user holds, so the "your app may ask you
to approve running the setup command" heads-up shows generically for the whole
command path during the waiting state, sharpening to the app-specific wording
once the connector's resolve reports the detected runtime.
`--doctor`/`--repair` still require an explicit `--runtime` (they examine a
stored config, which is a choice, not a detection).

## Guidance surfaces (skill parity, #1332)

Setup also installs the generic, secret-free payment skill wherever the
runtime has a documented instruction mechanism. The substance is the single
canonical string in `packages/sdk/src/skill-content.ts` on every runtime —
only the wrapper differs, never the content:

- **Claude Code** — `~/.claude/skills/haven-pay/SKILL.md` (canonical bytes).
- **Hermes** — `$HERMES_HOME/skills/haven-pay/SKILL.md` (default
  `~/.hermes/skills/…`); Hermes auto-discovers SKILL.md skills in the same
  front-matter format, so the file is byte-identical to the Claude install.
- **Codex CLI / Codex Desktop** — a marker-delimited managed section in the
  global `~/.codex/AGENTS.md` (Codex's documented global-guidance file, shared
  by both). The section carries the skill body without front matter
  (`HAVEN_SKILL_BODY_MD`); re-runs replace the section in place, everything
  outside the markers is preserved byte-for-byte, and a damaged marker pair
  makes the write fail closed with the file untouched. `AGENTS.override.md` is
  never written.
- **Every other runtime** (Cursor, VS Code, Claude Desktop, `other`) — no
  documented instruction file; the MCP server-level initialize instructions
  carry the baseline guidance and nothing is written.

A guidance write happens only when the runtime config write itself succeeded,
and a failed skill install never fails the setup — the messages point at the
dashboard download instead.

## Completion handoff after Connect

The published `haven-connect` package is also checked through the npm bin
topology: the package smoke test invokes its packed `node_modules/.bin`
symlink, not only `node dist/cli.js`. This matters because Node keeps the
symlink path in `argv[1]`; Connect resolves it before deciding whether it is
the program entrypoint. A command that exits with no output before it creates
the local files has not registered an agent and must not be described as a
completed connection.

The connector's final output is deliberately short, ordered, and — since #1542
— shaped by what its own approval wait observed. When the budget is still
pending (or the wait was skipped): return to Haven to approve the budget first,
activate the current runtime second, then run the read-only `haven_get_agent`
and `haven_get_allowances` tools to confirm the Haven wallet and live budget.
Approval — not a restart — unlocks Haven tools. When the wait itself saw the
approval land, the handoff confirms it instead of re-requesting it — the
connector never celebrates the approval and then instructs the user to go
perform it — and only the activation and verification steps remain. When the
setup ended in Haven during the wait, the single next step is a fresh
connection from the dashboard. One name for the gate throughout the
connector's output: the **budget** (never "agent rules"). The activation step
for restart-bound runtimes also states why it survives the connector's own
in-process verification: session/app-scoped runtimes only read MCP config at
start-up. The verification must not sign, fund, or create a payment.

Since #1377 the connector does not go silent after registering, and since
#1543 the budget-approval unlock no longer waits for the whole install: the
moment the runtime MCP config write settles — before the network probes and
the skill install, whose tail approval does not depend on — the connector
sends an early, best-effort install-status report carrying the config-write
facts (configured/consent booleans, restart and next-action state; no probe
verdict, no skill state), which is what the dashboard's approval unlock
actually reads. After probes and skill install finish it makes the complete
install-status report — still the authoritative one, refining the same keys
with probe verdicts and skill state, and the fallback unlock path when the
early report failed (either report's failure is silent and cannot activate an
agent or change budget authority). It then polls the narrow read-only
`connector-status` endpoint (pending agent
API key, usable while `setup_pending`-scoped) and waits for the budget approval
— an immediate first check (#1542: users routinely approve while the install
is still running, and the "waiting for you to approve" line is only printed
once a check has actually observed a pending state, never ahead of a first
check that may find the wait already over), then every 5 seconds, for at most
3 minutes, with a progress reminder every 30 seconds. A failed report remains
readiness metadata only: it cannot activate an agent or change any budget
authority. On approval it prints a celebratory line
naming the granted authority (amount, token, reset period); on a terminal setup
status it says the setup ended in Haven; at the bound it exits cleanly with
"approve whenever ready" guidance — the connector always terminates on its
own. A flaky poll is retried inside the same bound, never treated as a verdict.
`--json` automation runs skip the wait entirely so the structured outcome is
emitted promptly.

Before registration, the dashboard stages what it says about a missing
connection over three periods, in one status slot that is never empty (#1399).
On arrival it says only that it is waiting for the agent to run the setup
command. After one minute of a confirmed `awaiting_connection` it acknowledges
that a first run downloads the connector before it can register — an
observation, not a warning: it offers no recovery actions and does not suggest
anything is wrong. After **three minutes** of confirmed `awaiting_connection`
it says Haven has not received a connection yet, asks the user not to approve
agent rules, offers the same local command for copying, and lets them cancel
the one-time setup before creating a fresh prompt. A status-read error resets
the clock rather than advancing it: it remains an error state, not evidence
that the connector succeeded or failed.

That three-minute bound is sized against a cold `npx` download on a poor
network — the case that most often strands this screen — and is not tied to
anything else. It happens to equal the connector's approval wait described
above, but the two are **not** coupled and must not be reasoned about as a
pair: `waitForBudgetApproval` only starts once `registerSetup` has succeeded,
and a successful register moves the setup to `connected_local`, which is
precisely the transition that ends the dashboard's `awaiting_connection` clock.
The two govern disjoint phases and can never run concurrently, so either can be
retuned on its own evidence. They live in `AWAITING_CONNECTION_RECOVERY_MS`
(`packages/frontend/src/hooks/useAgentConnectionSetupStatus.ts`) and
`waitForBudgetApproval`'s `timeoutMs` default (`packages/connect/src/runtime.ts`).

Automation can pass `--json`: Connect keeps progress and recovery prose on
stderr and emits one parseable, versioned object on stdout. `schema_version: 1`
is the stable contract; `outcome` is `complete`, `action_required`, or
`failed`. The record carries runtime/topology, configuration and probe state,
activation, next action, approval and any approval expiry, and read-only
verification guidance. It is
redacted by construction: no API/private keys, credential contents, full
credential paths, or full delegate address are serialized. Library callers use
the same object at `runConnect(...).outcome`.

Activation is owned by the Connect runtime registry. Claude Code needs a new
session; Codex CLI can start a fresh session with `codex resume --last`; Codex
Desktop and Claude Desktop need a full app restart; Cursor and VS Code hot
reload; and Hermes needs a new session or `/restart` in Gateway. An unknown
runtime is the only manual case: Connect cannot write its configuration, so use
the secret-free file references it prints and then start a fresh session.

If a setup challenge has expired, return to Haven for a fresh connection and
rerun Connect. If a package install, runtime configuration, or MCP probe fails,
use the structured `error.code` and `error.next_action` (or the matching human
recovery note). Never manually edit runtime configuration or paste credentials
into prompts, logs, or configuration. The `other` runtime is intentionally
`action_required`: finish the secret-free manual setup references, then start a
fresh runtime session; do not request another one-shot setup solely because the
runtime is unrecognized.

Normal Connect output abbreviates the public delegate address. For an operator
diagnostic that needs the full public identifier, use the owner-only, non-secret
`agent.json` orientation file Connect reports. Never inspect or share
`identity.json` or `signer.json` for that purpose: they contain credentials.

## Where the Node floor is enforced

`>=22.0.0` is declared in three places that must agree: the `engines.node` of the
four packages this floor governs (`sdk`, `connect`, `signer`, `mcp`),
`HAVEN_MINIMUM_NODE_VERSION` in `@haven_ai/sdk`, and
`MCP_RUNTIME_MANIFEST.minimumNodeVersion`. The manifest field is **derived** from
the SDK constant, and a guard test in each of those four packages pins its own
`engines.node` to it. They cannot drift silently. `.nvmrc` is separate: it pins
the version the repo itself develops and runs CI on (LTS 24), which may sit
*above* the user-facing floor but never below it. The floor is what an agent's
machine must satisfy; `.nvmrc` is what ours does.

The floor is 22 (maintenance LTS until April 2027) rather than 24 because the
runtime uses nothing newer than `AbortSignal.any` (Node 20.3), and Node 20 is
past end-of-life — 22 is the oldest still-supported LTS
([#1352](https://github.com/d-hinders/Haven-AI/issues/1352)).

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

That list was already correct when [#1526](https://github.com/d-hinders/Haven-AI/issues/1526)
was filed; the **manifests** were what disagreed. `mcp-server` and
`demo-merchant-mcp` lacked `private: true`, so tooling that classified by that
flag — `release-bump.mjs` and connect's `package-smoke.test.ts` — treated them
as published and demanded exact internal pins. Both are now flagged private and
use `"*"`, which is what a workspace-only consumer must use; `npm run
lint:workspace-pins` enforces both directions of that rule on every PR. Nothing
about the runtime floor, the version-skew contract, or the Supported Runtime
Manifest below moves — the published set this section governs is unchanged at
`sdk`, `signer`, `mcp`, `connect`, `cli`.

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
  MCP packages. The smoke packs Connect plus local SDK/MCP artifacts, verifies
  the packed npm bin starts through an npm-style symlink, stages them into a
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

**Row one is now machine-readable, not just named (#1309).** The Zod rows
above are a diagnosability gap the table exists to translate; row one — a
signer ≥ the #1143 release, still stale relative to the backend — no longer
needs that translation, because it is now structured at the source. The tool
boundary (`haven_sign` / `haven_sign_x402` / `haven_sign_sweep_delegate`)
returns the row-one message verbatim (unchanged) PLUS
`{ code: 'UNSUPPORTED_EXPECTED_CONTEXT_VERSION' | 'UNSUPPORTED_SWEEP_BINDING_VERSION',
supported_versions, received_version, fallback, next_action:
'stop_and_tell_user' }` — `assertSupportedBindingVersion` in
`packages/signer/src/core.ts` throws a typed
`HavenUnsupportedSignerVersionError` (`@haven_ai/sdk`) instead of the plain
`HavenSigningError` every other signing refusal uses, so `code` and the two
version fields are DERIVED at the throw site from
`SUPPORTED_X402_EXPECTED_VERSIONS` / `SUPPORTED_SWEEP_BINDING_VERSIONS` rather
than a second hand-written literal. `fallback` is the same
`SIGNER_UPDATE_FALLBACK` string the hosted quote's advisory
`signer_compatibility.fallback` (below) carries, so an agent that hits either
surface is told the identical fix. This narrows *how* the refusal is
diagnosed; it enforces nothing new — nothing was ever signed on this path
either, before or after.

One more skew row since #1272: the hosted x402 quote tools are **compact by
default** — no `typed_data`/`typed_data_b64` in the response. A signer old
enough to lack the #1263 `payment_id` fetch (or an install missing
`identity.json`) therefore has no byte source in the default flow; its error
names the fallback, and the recovery is to re-run the quote tool with the SAME
`idempotency_key` plus `include_signing_payload=true`, which replays the
ORIGINAL sign_data (#1207) with the full payload. This is a transport change
only — the signer's verification is identical on both paths — but it converts
"old signer silently relays bulk bytes" into "old signer asks for them
explicitly", which is the observable difference an operator will see.

One more skew row since #1307, on the SETTLE leg rather than the sign leg:
`haven_settle_mcp_tool` / `haven_complete_mcp_tool` accept `merchant_url` /
`tool_name` / `arguments` / `mcp_transport` as optional and rehydrate them by
`payment_id` from the stored intent when omitted. Omitting them against a
backend that never stored a call context — pre-#1307 backend, or an intent
that was never quoted through `haven_pay_mcp_tool` (a plain non-MCP-tool x402
resource) — gets a structured `MERCHANT_CALL_CONTEXT_UNAVAILABLE` refusal
naming the fallback in-band: re-send the four fields explicitly (the same
values `haven_pay_mcp_tool` returned at quote time). Same shape as the
`include_signing_payload=true` fallback above: no signature verification
changes, only which call carries the bulk bytes.

On a successful hosted settle (#1349), agents report from the compact
`agent_summary.purchase_summary` rather than parsing the merchant's raw
`result`. This is a backward-compatible reporting extension only: Haven state
sets status and payment fields, while product/invoice metadata comes from the
merchant and `settlement_tx_hash` is only an optional merchant PAYMENT-RESPONSE
receipt reference. Missing values are explicit; it changes neither signing nor
runtime compatibility.

`haven_prepare_catalog_purchase` (#1306) — the guided catalog-id preflight —
persists the SAME `mcpCallContext` at quote time (it composes the identical
authorize calls `haven_pay_mcp_tool` uses, just sourced from a
`merchant_catalog` row instead of caller-supplied fields — since #1547 that
includes the settlement-scheme selection, so on the delegation rail against an
erc7710-advertising merchant it composes `prepareX402Erc7710` with the same
context passthrough rather than `createX402Intent`), so it carries no
separate skew row: the settle leg above rehydrates a catalog-preflight-created
intent exactly like a `haven_pay_mcp_tool`-created one on either scheme, and
the `signer_compatibility` version check on the QUOTE side (table above)
applies identically to its 3009 shape (the erc7710 shape carries no
`signer_compatibility`, like `haven_pay_mcp_tool`'s — the signer's own
signing-time refusal is the guard there, as everywhere).

### Detecting skew before a payment (#1155)

Every row above is a *post-quote* symptom: the agent found out by trying to pay.
The same skew is now detectable at connection time, from two surfaces that cost
nothing to read.

| Surface | What it states | Where |
|---|---|---|
| Signer `initialize` result | The version sets this signer will verify — `capabilities.experimental["haven/signer-compatibility"]` (machine-readable) and the same numbers in `instructions` (what clients show the model) | `packages/signer/src/capabilities.ts`, wired in `buildSignerMcpServer` |
| Hosted quote/prepare result | `signer_compatibility.x402_expected_context_version` — the version that quote will emit — plus in-band guidance (since #1547: branch on the signer's machine-readable version-mismatch refusal, not a pre-compare) | `packages/mcp-server/src/tools.ts` (`haven_pay_x402_quote`, `haven_pay_mcp_tool`, `haven_prepare_catalog_purchase`) |

**The information is agent-mediated, and cannot be otherwise.** The signer and
the hosted MCP are two separate servers connected to the same agent client. The
hosted server cannot introspect the signer, and the signer never calls the Haven
API — it only signs. Only the agent sees both surfaces. #1155 shipped the
information plus a prompt to COMPARE the two — and field experience (#1547)
showed that prompt was unperformable in most agent harnesses, which do not
expose an MCP `initialize` result to the model; agents "checked" by re-reading
instruction prose. The shipped guidance therefore no longer asks for a
pre-compare: it names the signer's signing-time structured refusal (#1309 —
`code` / `supported_versions` / `received_version` / `fallback`) as the branch
point, which every harness can act on because it arrives as a tool result. The
`initialize` surfaces above still advertise the sets for harnesses (and
humans) that can read them; nothing about what is ENFORCED moved.

**A mismatch warns, it does not block** (owner decision, 2026-08-07; unchanged by
#1309). No refusal was added to the payment path: a quote whose emitted version
the signer may not know still succeeds and simply reports the number. Refusing
on the strength of reported client metadata would let a false positive block a
working payment, which is strictly worse than the reactive state — and the
signing-time guard above already fails closed, so nothing is unguarded. Both
surfaces name the same fix (update `@haven_ai/signer`; rerun
`npx @haven_ai/connect@alpha`), so an agent that meets either says the same
thing to the user — and since #1309 that is not just true of the prose: the
quote's `signer_compatibility.fallback` and the signer's own structured
refusal `fallback` field are the SAME string
(`SIGNER_UPDATE_FALLBACK`, `@haven_ai/sdk`), so an agent reading either as
data gets byte-identical guidance, not merely similar wording.

**`signer_compatibility` is the stable contract this pre-payment check reads
(#1309).** Its shape — `x402_expected_context_version`, `signer_capability`,
`check` (prose), and now `fallback` (the same guidance as structured data) —
was already sufficient for the acceptance bar "hosted MCP quote/preflight
responses surface compatibility requirements in a stable field"; `fallback`
is the one field #1309 added, because it was the one piece of `check` an
agent could not previously read without parsing a sentence. See
`signerCompatibilityNotice` in `packages/mcp-server/src/tools.ts`.

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

**Both payment-brain servers set `instructions` too (agent-prompt audit, items
A/B).** `ServerOptions.instructions` above is the mechanism the signer's own
handshake reuses; `buildHostedMcpServer` and `buildMcpServer` (the local
runtime) now set it as well, with a compact critical path — deliberately free
of any version literal, since nothing there should ever need a release to stay
true (unlike the signer's compatibility numbers above, which are point-in-time
by design). See [`07-edge-signer.md`](../architecture/07-edge-signer.md) for
what each server's instructions say and why they differ in length.

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
  Node.js `>=22.0.0`, and
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
- **Signer runtime install failed (`signer_runtime_install_failed`, #1586):**
  the hosted+signer setup now fails CLOSED — no runtime configuration is
  written at all, because a config pointing at an uninstalled signer looks
  wired but structurally cannot start (Codex kills the multi-minute npx cold
  install at its 120s `startup_timeout_sec`, leaving corrupted `_npx` dirs).
  There is no silent npx fallback anymore. The install budget is 10 minutes
  with console heartbeats; on failure, address the cause (network, npm cache)
  and rerun `npx @haven_ai/connect@alpha`.
- **Claude Code does not show Haven:** run `claude mcp get haven` and confirm
  it points at the wrapper path. If `add-json` is unavailable, the connector
  falls back to `claude mcp add --scope user -- <wrapper>`.
- **Tools missing after restart:** rerun the connector. It will reuse the
  existing local credentials, reinstall or reuse the pinned MCP runtime, and
  fail loudly if the wrapper handshake cannot list the required Haven tools.
- **Tool naming across runtimes (#1588):** guidance responses carry
  `next_tool` (Claude-family namespaced, `mcp__<server>__<tool>`, kept
  byte-identical for existing clients) **plus** the runtime-neutral pair
  `next_tool_server` (`haven` / `haven-signer`) and `next_tool_name` (the bare
  tool name). Codex names servers by config key — connect writes
  `haven_signer` (underscore; TOML) — so the prefixed form matches nothing
  callable there; agents on such runtimes resolve via the pair.
- **`--doctor` / `--repair` (#1589):** a stuck setup is diagnosable without a
  hand-built MCP client: `npx @haven_ai/connect@alpha --doctor --runtime
  <runtime>` checks config, credentials, the pinned signer runtime, the hosted
  MCP, and runs the live signer handshake (reporting its compat versions),
  printing one repair action per failure and exiting non-zero. `--repair`
  reinstalls the pinned runtime and rewrites wrapper + config from STORED
  credentials — no new setup token, keys untouched. `--json` for automation.
- **Signer verified by handshake (#1587):** in the hosted+signer topology the
  connector now proves the LOCAL signer with the same stdio handshake the
  hosted server gets (initialize → tools/list → required signer tools, the
  list derived from the pinned `@haven_ai/signer`). `localSignerConfigured`
  is true only after that handshake; a signer that cannot spawn, times out,
  or lacks tools reports `local_signer_probe_<status>` with a re-run
  instruction — setup can no longer exit 0 on an unstartable signer.
- **Credential safety:** private signing keys live only in
  `~/.haven/agents/<agent-id>/signer.json`. Do not paste signer files, wrapper
  sidecars, or command output into public issues without redacting secrets.
