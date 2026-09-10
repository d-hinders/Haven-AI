---
owner: "@d-hinders"
status: current
covers:
  - packages/mcp-server/src/**
  - packages/connect/**
  - packages/signer/**
  - packages/frontend/src/components/ConnectAgentModal.tsx
  - packages/frontend/src/hooks/useAgentConnectionSetup.ts
  - packages/backend/src/routes/agent-connection-setups.ts
  - packages/backend/src/routes/payments.ts
  - packages/backend/src/routes/x402.ts
  - packages/backend/src/rails/sweep.ts
  - packages/sdk/src/client.ts
  - packages/sdk/src/account-reads.ts
  - packages/sdk/src/delegate-sweep.ts
  - packages/sdk/src/haven-api-transport.ts
  - packages/sdk/src/mcp-merchant-transport.ts
  - packages/sdk/src/payment-mappers.ts
  - packages/sdk/src/payment-state.ts
  - packages/sdk/src/x402.ts
  - packages/backend/src/modules/x402/delegation-authorize.ts
last-verified: "2026-09-08"
---

# Haven — Hosted MCP Connect Flow And Edge-Signing Contract

Hosted MCP is keyless: it authenticates agent identity, reads state, constructs
unsigned payment payloads, and relays signatures. Signing stays with the agent
runtime or `@haven_ai/signer`.

## Trust boundary

| Component | Holds | Responsibility |
|---|---|---|
| Hosted MCP | API key / Bearer token | Identity, state reads, orchestration, unsigned payload construction, signature relay |
| Edge signer | Delegate private key | Local signing authority |
| Budget delegation | On-chain caveat enforcers | Automatic-spend enforcement |

API authentication is identity, a delegate signature is authority, and the
on-chain caveat stack is enforcement. Hosted MCP must never accept, store, or log a
delegate key. It has a boot-time guard that rejects an injected key.

For direct funding relay, the agent sends only the locally produced
`{ payment_id, signature }` to hosted MCP. Paid MCP completion may additionally
send a signed, merchant-bound `payment_header`; that single-use authorization
is not a key.

## Current connection flow

Staged Connect Agent pairing is the only current dashboard flow, and it is
available only for delegation accounts. Legacy Safe records are not rendered at
all since #2413, so this flow is unreachable for one rather than being refused:
`ConnectAgentModal` no longer carries a retired-rail branch, and the notice
component it showed is deleted. Existing legacy Safe
permissions require action by the Safe owner outside Haven.

1. The user chooses the Haven wallet, agent rules, and agent budget.
2. Haven creates a pending setup and returns a setup token and connector
   command.
3. The connector normally runs locally, generates the delegate signing key and
   API key, and stores both in protected local runtime configuration. Before
   it generates anything it checks whether this machine's bare `haven` /
   `haven-signer` pair already belongs to a different agent with a live key
   ([#2551](https://github.com/d-hinders/Haven-AI/issues/2551)): a terminal is
   asked to replace or install alongside, a non-interactive run refuses, and
   either way declining reaches neither key generation nor step 4. A server
   or hosted backend cannot run it (the command writes files under `~/.haven`
   and edits a local MCP config), so for those the connect flow offers a
   supported credential path: one click into a top-level disclosure directly
   under the setup prompt issues a one-time credential to save into the
   backend's own secrets. It is marked as a manual credential rather than as a
   configured local runtime, and the owner still signs the budget delegation
   before the agent can spend.
4. Registration sends only the setup token, runtime/version metadata, public
   signing address and proof, API-key hash/prefix, the MCP server name the
   connector wired this agent as (`haven`, or `haven-<slug>` — a display label
   the dashboard shows so several agents in one harness can be told apart;
   #1878), and `run_mode` (`json` | `prose`, #2528 — whether the connector ran
   with `--json`, which only the connector can report and which segments the
   onboarding funnel; refused with 400 if it is anything else). No private key
   or plaintext API key is registered. The response returns `approval_url`
   (#2528), the same-origin link to this setup's budget approval that create
   and status already return — a page address, carrying no token.
5. The user approves, in the modal, with one signature — and that signature is
   the authority. On the delegation rail it is the budget delegation itself,
   granted at the same step of the same flow; the agent cannot spend until that
   budget is active, and its limits are carried by the caveat enforcers at
   redemption rather than by a module permission. Legacy rails never reach this
   step in the current dashboard.
6. Later hosted requests use the locally stored API key as Bearer identity;
   the local signer retains the delegate key as authority.

Manual credential generation is a supported integration path for servers and
hosted backends (#2482), surfaced as its own top-level disclosure in the
connect flow rather than hidden inside a warning-gated fallback — the UI no
longer fronts it with a warning panel and acknowledgement. Normal setup links
and snippets may contain hosted identity configuration, but never a delegate
key. The manual credential may display a one-time delegate private key only
after the user generates it; it is not part of routine connection snippets.
Its registration records the public address, proof, API-key hash/prefix, and a
non-secret manual-fallback marker only. That marker does not create authority
or activate the agent: the user still makes the same owner-signed budget
delegation in step 5.

## Direct payment

1. `haven_pay` asks the backend to construct a payment intent.
2. Within the remaining budget, it returns `payment_id`, `payload_hash`, and
   expiry. Above the remaining budget it is **declined before any money moves**
   — nothing is queued and no one is asked to review it, because there is no
   approval queue on the delegation rail (`approval_requests` went with #2055).
3. `haven_sign` signs the payload locally.
4. `haven_submit` relays the signature; the backend verifies the delegate and
   submits the sponsored UserOp that redeems the budget delegation.

## x402

The recommended paid-MCP path is:

```text
haven_pay_mcp_tool
  → haven_sign_x402
  → haven_settle_mcp_tool
```

Hosted MCP prepares the funding and merchant contexts, the signer locally
authorizes both legs, and hosted MCP relays the signed merchant authorization.

The generic decomposed path remains available, in two shapes since
[#2041](https://github.com/d-hinders/Haven-AI/issues/2041) — the scheme is
chosen by the shared #1450/#1453 selector and reported as `settlement_scheme`,
never inferred by the agent:

```text
EIP-3009 bridge (any rail; the only shape before #2041)
haven_quote_x402 / haven_pay_x402_quote
  → haven_sign
  → haven_submit                       (relays the FUNDING signature)
  → haven_x402_sign_header
  → merchant retry or haven_complete_mcp_tool
  → haven_report_x402_outcome          (only when YOU did the retry)

erc7710 direct settlement (delegation rail + merchant advertises it)
haven_quote_x402 / haven_pay_x402_quote
  → haven_sign                         (signs the SETTLEMENT CHILD)
  → haven_submit { settlement_scheme: "erc7710" }  → payment_header
  → merchant retry
```

**Why the last EIP-3009 step exists at all
([#2292](https://github.com/d-hinders/Haven-AI/issues/2292)).** The two
branches of "merchant retry **or** `haven_complete_mcp_tool`" are not
symmetric, and the asymmetry is the point of this whole flow: on the
`haven_complete_mcp_tool` branch Haven makes the merchant call and therefore
*observes* the outcome, writing the evidence or reconciliation row itself. On
the plain-HTTP branch Haven never contacts the merchant — it holds no key and
speaks to no merchant — so the outcome only exists in the agent. Without a
report, the funded-but-undelivered detection this doc describes could not fire
for fifteen minutes on the one flow Haven prescribes.

`haven_report_x402_outcome` is that channel, and it is a separate tool rather
than a mode on `haven_complete_mcp_tool` for the same reason the branches
differ: one records an observation, the other records an assertion. It records;
it never verifies, because verifying would mean Haven calling the merchant. Its
authority boundary — what is checked, what deliberately is not, and what a
hostile caller can and cannot achieve — is written up in
[`04-x402-payment-sequence.md`](04-x402-payment-sequence.md) rather than
restated here.

The erc7710 shape is shorter by exactly the funding leg: no funding relay to
confirm, no `haven_x402_sign_header`, no delegate hot balance and nothing to
sweep.

> ⚠️ **Nothing on the LEGACY allowance rail runs: not the coverage split below,
> not hosted keyless x402 at all.** The split was that rail's arithmetic, and
> its middle branch is the approval queue epic #1440 retired. Since #1986
> `POST /x402/authorize` answers HTTP 410 for an `allowance_module` account,
> above the funding leg, so no funding intent and no funding hash is ever
> produced for the edge signer to sign on that rail. The split is kept as the
> record of what the rail did (#2130); the live behaviour is stated immediately
> after it.

- `amount <= remaining allowance` could execute;
- `remaining < amount <= remaining + delegate balance` **queued for approval**;
- `amount > remaining + delegate balance` was rejected as insufficient coverage.

**On the live delegation rail there is no middle branch.** An over-budget
amount is refused outright and nothing is queued. **Both** x402 shapes now
pre-check the live remaining budget at authorize and answer
`403 delegation_budget_exceeded` — erc7710 since #2082, the EIP-3009 funding
shape since #2706. Both pre-checks **fail open** on a degraded on-chain
read, but the consequence differs and the difference is the whole point of
#2082. The EIP-3009 shape proceeds to prepare, where the redemption is
estimated and the caveat enforcer's refusal surfaces as a `502` with no intent
row — which is also what `POST /payments` does on every request. The erc7710
branch prepares **nothing**: it re-delegates a narrowed child and hands it
back, so a failed-open over-budget request comes back `201 pending_signature`
**with** `sign_data`, and the refusal only lands on-chain when the merchant
redeems. That is the #1993 shape #2082 closed at authorize, reappearing exactly
when the budget read degrades. On erc7710 a degraded read is therefore the
alarming outcome, not a reassuring one. The legacy rail answers `410`
before either (#1986). No branch of any of them returns a funding hash.

This paragraph described the EIP-3009 `502` as live behaviour for two days
after #2706 changed it. #2706's own doc pass corrected
`04-x402-payment-sequence.md` and missed this file, and nothing bound them —
this document had no `covers:` entry for
`packages/backend/src/modules/x402/delegation-authorize.ts`, so `docs:check`
had nothing to say when that file changed under it. The entry is added in the
same pass that found the drift, which is the only reason the correction is not
the kind that has to be made twice. Found by review of PR #2753 (#2738).

**That 410 is RAIL-SCOPED, and the scope is the correction** — the banner above
says hosted keyless x402 does not run on the LEGACY rail, not that it fails for
any account, and the difference is the whole point. This section previously said
hosted x402 worked for **no** account, reasoning from a second claim — that the
hosted construct refuses typed-data funding intents — which had already stopped
holding when it was written. `docs/architecture/08-local-vs-hosted-mcp.md`
records the measurement (2026-08-25): #1254 forwards `signature_scheme` +
`typed_data` verbatim to the edge signer, #1456 added the hosted erc7710 settle
branch, and BOTH hosted schemes have green QA scenarios against the real
deployed hosted MCP and the real signer. The #1986 fail-close is **rail-scoped**
and applies to both topologies equally: it removed the legacy rail, never the
hosted surface.

[#2041](https://github.com/d-hinders/Haven-AI/issues/2041) falsifies the blanket
claim a second, independent way, which is why it is corrected here rather than
left to contradict `08`: a delegation-rail account now completes an erc7710
x402 payment end to end through exactly this generic decomposed surface —
`haven_pay_x402_quote` → `haven_sign` → `haven_submit` — with no funding leg at
all.

**Hosted DIRECT payments are a separate question and are NOT affected in kind:**
`POST /payments` serves both rails and its delegation branch is untouched by
#1986, so a delegation-rail account still creates a signable intent there. It
is the x402 keyless construct specifically that has no working rail left.

After a successful paid retry — including the hosted completion path
(`completeX402MerchantCall`) — the SDK captures a merchant-issued receipt from
the paid response's `x-receipt-json`/`x-receipt-url` headers and reports it,
best-effort, to `POST /machine-payments/:id/merchant-receipt`.

## Tool surfaces

Hosted MCP provides identity and allowance reads, direct send/prepare/submit,
x402 and MPP quote/resume/status operations, paid-MCP prepare/settle,
receipt listing and verification, discovery, and gasless USDC sweep
orchestration. The exact registered union is in
`packages/mcp-server/src/tools/contracts.ts` since #2807, re-exported by
`packages/mcp-server/src/tools.ts`, which stays the facade every embedder
imports.

**An argument the tool does not declare is refused — on 20 of the 22 hosted
tools (#2312, #2348, #2349, #2353).** It began with the money-path tools that read
from a record: several hosted tools take a `payment_id` and read the rest —
amount, recipient, merchant, resource URL, funding transaction — from the
payment's own stored row. A permissive parse dropped any other key silently, so
a caller could believe it had pinned one of those values when it had not, and
the call would still **succeed**. That is the same class as the authority rule
in [CASP guardrails](../regulatory/casp-risk-guardrails.md): what a caller
supplies must not quietly decide what Haven acted on. #2349 closed the list on
the principle every hosted schema already advertised (`additionalProperties:
false`): every tool is on exactly one of two explicit lists in the same file —
`STRICT_INPUT_TOOLS`, with the reason each refuses, or `PERMISSIVE_INPUT_TOOLS`,
with the reason each still strips (the two `{}`-schema reads, whose handlers
take no input and which a supported runtime decorates with a dummy key) — and a
tool on neither does not compile. `haven_complete_mcp_tool`, held out for
#2353's rollout, joined the strict set once the corrected `SKILL.md` had
shipped to npm (see `08-local-vs-hosted-mcp.md`).

Where the refusal happens matters, because it is not where you would guess: the
MCP SDK validates a call against the registered input schema and hands the
handler the already-parsed arguments, so a check inside a handler never sees an
undeclared key over the transport. Strictness is declared at registration; the
handler-level check remains for callers that import `createToolHandlers`
directly. The advertised JSON Schema is unchanged — it already said
`additionalProperties: false`.

The edge signer exposes four local, sign-only tools. Three of the four never
reach the network; the exception is the `{ payment_id }` form of `haven_sign`
and `haven_sign_x402`, which since #1263 fetches that payment's exact signing
context from Haven over an authenticated, read-only
`GET /x402/:payment_id/sign-context`. The delegate key is never part of that
request or its response, and nothing here relays, submits, or broadcasts:

| Tool | Purpose |
|---|---|
| `haven_sign` | Sign a prepared payment hash |
| `haven_x402_sign_header` | Sign the decomposed merchant authorization |
| `haven_sign_x402` | Sign the recommended paid-MCP funding and merchant contexts |
| `haven_sign_sweep_delegate` | Sign a gasless delegate-to-wallet USDC sweep |

## Review checklist

- Hosted services never receive a delegate key.
- Setup registration contains public proof, hashed API-key metadata, and the
  connector-reported MCP server name — a display label only, never authority
  (nothing keys off it, and it is not unique).
- API-key rotation changes identity credentials, not signing authority.
- Declined or insufficient requests expose no signable hash — nothing is queued.
- x402 authorization is bound to amount, merchant, resource, asset, and network.
- Sweep authorization is bound to the registered delegate and Haven wallet.
- Live delegation agents can be paused or revoked in Haven; legacy Safe
  permissions require action by the Safe owner outside Haven.

## Related docs

- [x402 payment sequence](04-x402-payment-sequence.md)
- [Edge signer](07-edge-signer.md)
- [Local vs hosted MCP](08-local-vs-hosted-mcp.md)
- [CASP / MiCA guardrails](../regulatory/casp-risk-guardrails.md)
