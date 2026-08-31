---
owner: "@d-hinders"
status: current
contract: true
covers:
  - packages/backend/src/routes/x402.ts
  - packages/backend/src/modules/x402/**
  - packages/backend/src/routes/x402-resources.ts
  - packages/backend/src/modules/payments/agent-payment-status.ts
  - packages/backend/src/modules/x402/x402-delegation.ts
  - packages/backend/src/infra/chain/settlement-transfer-verifier.ts
  - packages/backend/src/rails/delegation-rail.ts
  - packages/backend/src/routes/catalog.ts
  - packages/backend/src/routes/machine-payments.ts
  - packages/sdk/src/client.ts
  - packages/sdk/src/x402-protocol.ts
  - packages/sdk/src/x402-funding-leg.ts
  - packages/sdk/src/x402-erc7710.ts
  - packages/sdk/src/merchant-completion.ts
  - packages/sdk/src/mcp-merchant-transport.ts
  - packages/sdk/src/payment-state.ts
  - packages/sdk/src/x402.ts
  - packages/sdk/src/merchant-discovery.ts
  - packages/mcp/src/tools.ts
  - packages/mcp-server/src/tools.ts
  - packages/signer/src/core.ts
  - packages/signer/src/tools.ts
  - packages/qa-agent/src/scenarios/x402-hosted-mcp-signer.ts
# #1496: a casp-changelog shard satisfies this doc too — every money-path PR
# already writes one, and mandatory note-prepends to last-verified caused three
# merge conflicts in one day between PRs that were not otherwise in conflict.
satisfied-by:
  - docs/regulatory/casp-changelog/**
last-verified: "2026-08-30" # chain-reset(#1496): verification notes live in docs/regulatory/casp-changelog/ shards (satisfied-by above) — this line is date-only from now on; per-change history is in the shards and git log
---

# Haven - x402 Payment Execution Sequence

How an agent pays for an x402-protected resource through Haven today.
Standard merchant-verifiable x402 support is `exact`-scheme USDC on Base and
Base Sepolia. Haven can parse some additional network/token forms for legacy
proofs and display, but they are not part of the standard settlement path.

Standard merchant x402 has two legs:

1. Haven funding leg: within budget, an agent-signed Safe AllowanceModule
   transfer funds the delegate wallet. Over budget, the user must approve and
   execute a Safe funding transaction.
2. Merchant leg: the agent signs the standard EIP-3009 `X-PAYMENT` header from
   the delegate wallet and retries the merchant/resource request.

> ⚠️ **The legacy AllowanceModule two-leg described below NO LONGER RUNS.**
> Under epic #1440 the Safe rail was closed to new accounts by #1984 and then
> **fail-closed for spending by #1986**: `POST /x402/authorize`, `POST /x402`,
> `POST /payments`, `POST /payments/:id/sign` and `POST /machine-payments/send`
> all answer **HTTP 410** for an `allowance_module` account — nothing written,
> no Safe→delegate funding transfer, no delegate hot balance. The sequence
> below is kept as the record of what the rail DID. The code that implemented
> it **has now been deleted** by #1987 — `modules/x402/legacy-authorize.ts` in
> full, along with the AllowanceModule transfer, transfer-hash generation and
> the allowance-nonce coordinator it drove. Read it as history: not behaviour
> you can invoke, and no longer behaviour in the tree. Accounts, balances and
> history stay readable.
>
> The live rail is the delegation rail: new accounts
> (`account_type='delegator_hybrid'`) settle x402 in a **single direct leg** via
> ERC-7710 — see [Delegation rail x402](#delegation-rail-x402-new-accounts)
> below. The Smart Sessions **session rail is retired** (#834) and answers its
> own, distinct HTTP 410 for `session_key` accounts; both tombstones coexist on
> the rail seam (`rails/execution-rail.ts`).

In SDK, local MCP, and generic hosted split flows, the agent retries the merchant
request. For paid MCP tools, hosted MCP can proxy the HTTP/MCP request and
deliver an already signed payment header. It remains keyless and does not act as
a facilitator/acquirer, hold merchant funds, or create the payment signature.

Source of truth:

- [`packages/sdk/src/x402.ts`](../../packages/sdk/src/x402.ts)
- [`packages/sdk/src/client.ts`](../../packages/sdk/src/client.ts) — the public
  `HavenClient` facade. Since #1618 (epic #1613) it delegates the x402 lifecycle
  rather than implementing it.
- [`packages/sdk/src/x402-protocol.ts`](../../packages/sdk/src/x402-protocol.ts) —
  what BOTH settlement schemes share: quote/receipt/resume shapes, the merchant
  request snapshot a resume replays, the `x402-wallet` header, and the checks
  that decide whether a payment is resumable at all.
- [`packages/sdk/src/x402-funding-leg.ts`](../../packages/sdk/src/x402-funding-leg.ts) —
  what only the EIP-3009 two-hop scheme has: funding confirmation, the
  delegate's fundability check (#1521), header minting from the local delegate
  key, and the authorization-keyed receipt cache. The erc7710 direct-settlement
  path has no funding leg and must not import this module; a test enforces that
  the protocol layer never does either.
- [`packages/sdk/src/x402-erc7710.ts`](../../packages/sdk/src/x402-erc7710.ts) —
  the direct-settlement lifecycle (#1619): scheme and rail selection, the
  authorize/settle halves the hosted topology drives with the local signer in
  between, and the refusals that keep it from ever silently rerouting to the
  3009 path. It asks no chain anything, because on this path there is no
  funding transaction to confirm and no delegate balance to check.
- [`packages/sdk/src/mcp-merchant-transport.ts`](../../packages/sdk/src/mcp-merchant-transport.ts) — bounded paid MCP/merchant HTTP delivery, sessions, and SSE framing.
- [`packages/sdk/src/merchant-completion.ts`](../../packages/sdk/src/merchant-completion.ts) —
  what must be true AROUND a merchant call once a payment exists (#1620): which
  wallet the merchant sees, what the payment's live state permits, and the
  evidence written afterwards. Scheme-neutral, so the erc7710 and 3009 paths
  finish through the same door. Every write here is best-effort and swallows:
  the resource is already paid for, and bookkeeping that threw would turn a
  completed payment into a reported failure.
- [`packages/sdk/src/payment-state.ts`](../../packages/sdk/src/payment-state.ts) — shared payment-state/status-error normalization.
- [`packages/backend/src/routes/x402.ts`](../../packages/backend/src/routes/x402.ts) — request
  validation, auth wiring, rate-limit config, and response serialization only.
  The authorize orchestration (scheme routing, funding-leg prep, erc7710 child
  building, the #961 replay/resume logic) and settle assembly live in
  [`packages/backend/src/modules/x402/`](../../packages/backend/src/modules/x402/index.ts)
  (#996, epic #980 M4). `x402-delegation.ts` lives inside that module (folded
  in by #998 — its only production consumers were already inside it) — it is
  the settlement *compiler* (typed-data / header assembly primitives), not
  route orchestration.
- [`packages/mcp/src/tools.ts`](../../packages/mcp/src/tools.ts)
- [`packages/mcp-server/src/tools.ts`](../../packages/mcp-server/src/tools.ts)
- [`docs/regulatory/casp-risk-guardrails.md`](../regulatory/casp-risk-guardrails.md)

## Challenge And Header Semantics

The SDK normalizes the merchant's 402 response into a `PaymentRequired` object.
It accepts the v2 `PAYMENT-REQUIRED` header, the v1 `X-PAYMENT` challenge
header, and a JSON-body fallback. When the delegate address is known, probes
also send `x402-wallet`. The paid retry uses `X-PAYMENT`; a successful merchant
response may include `PAYMENT-RESPONSE` evidence.

`quoteX402()`, `haven_quote_x402`, `haven_quote_mcp_tool`, and
`haven_quote_catalog_purchase` are read-only. The MCP variants establish the
merchant session and send an unpaid `tools/call` probe (and may read the public
agent delegate address to send `x402-wallet`), but none creates a Haven payment,
approval request, signature, funding operation, paid merchant retry, or
on-chain transaction. Every quote is informational rather than a price
reservation or payment authority.

Every merchant-facing SDK fetch (probes, MCP handshakes, paid retries,
resume retries) is bounded since #1300: `config.merchantTimeout` (default
**300 s**, calibrated to the protocol contract — the merchant's own
`maxTimeoutSeconds: 300` and viem's 180 s settlement wait; a test pins the
default at or above it), caller signals combined, timeout surfaced as the
typed `MerchantTimeoutError` (504, names the URL). A non-402 quote answer is
the typed `X402UnexpectedStatusError`. A timeout AFTER confirmed funding is
routed to `MERCHANT_UNRESPONSIVE_AFTER_FUNDING` with verify-then-sweep
guidance — an unanswered retry is not proof of rejection, and the merchant
may still settle late against its valid EIP-3009 authorization.

Since #1308 the hosted purchase responses carry a **structured next-step
contract**: `next_action` (values from the existing AgentPaymentNextAction
taxonomy), `next_tool` + small literal `next_arguments`, `safe_to_continue`
(false on the retained fail-closed `pending_approval` branch — on BOTH quote
tools and on the settle tool's non-payable-funding branch), a compact
`agent_summary`, and an advisory `warnings[]` (MISSING_MAX_AMOUNT absorbs the
#1275 cap nudge; QUOTE_EXPIRES_SOON; MERCHANT_URL_DISCOVERED). Warnings never
replace refusals; failure codes stay authoritative.

> **`safe_to_continue: false` is still a value the contract carries, but it is
> a DECLINE, not a queue** (#2121). The `pending_approval` status behind it is
> not minted by any live rail — the legacy rail answers 410 (#1986), the
> delegation rail refuses at prepare with nothing written, and
> `approval_requests` was dropped with its table by #2055. The branches are
> deliberately **retained fail-closed** (#2101/#2113) for a row stored before
> the retirement, and their verdict is `next_action:
> stop_and_tell_user`, never `wait_for_user_approval`. An over-budget amount
> on the delegation rail never reaches this field at all: it is refused at
> `POST /x402/authorize` (#2082). Read `safe_to_continue: false` as *stop and
> tell the user to raise the budget* — never as *wait for an approval*.

Since #1349, a successful hosted `haven_settle_mcp_tool` also places the default
reporting contract at `agent_summary.purchase_summary`: `{ status: 'settled',
product, amount, amount_atomic, asset, network, merchant, invoice_id,
funding_tx_hash, settlement_tx_hash, allowance }`. Haven payment state supplies
settlement status, money, merchant identity, and funding fields. `product` and
`invoice_id` are narrow merchant display metadata; `settlement_tx_hash` is an
optional merchant `PAYMENT-RESPONSE` receipt reference, not Haven settlement
proof. Missing values are explicit `null`. The top-level raw `result` remains
advanced merchant evidence and never decides whether Haven reports settlement.

Hosted `haven_pay_mcp_tool` additionally accepts a **base merchant URL**
(#1271): when the probe misses (non-402), it makes one bounded same-origin
discovery pass — GET `/.well-known/haven-demo-merchant` then `/`, no
redirects, off-origin `mcp_url` refused unfetched — and retries once at the
document's `mcp_url`, returning the resolved `merchant_url`. Discovery finds
endpoints; payment authority is unchanged.

`haven_pay_mcp_tool` additionally accepts a **base merchant URL**, in BOTH
topologies (#1271, ported to the local runtime in #1301 — the discovery
helper itself lives once in `@haven_ai/sdk` and both `packages/mcp` and
`packages/mcp-server` call it): when the probe misses, it makes one bounded
same-origin discovery pass — GET `/.well-known/haven-demo-merchant` then `/`,
no redirects, off-origin `mcp_url` refused unfetched — and retries once at
the document's `mcp_url`, returning the resolved `merchant_url`. The hosted
probe's miss is the typed `X402UnexpectedStatusError` (non-402); the local
flow has no dedicated probe step (`haven.fetch()` resolves a 402 itself), so
its equivalent miss is a non-ok `Response` from the untouched first hop.
Discovery finds endpoints; payment authority is unchanged.

## Standard SDK / Local MCP Flow

```mermaid
sequenceDiagram
  autonumber
  participant Agent as Agent runtime
  participant Resource as x402 resource server
  participant SDK as Haven SDK / local MCP
  participant API as Haven backend
  participant AM as Safe AllowanceModule
  participant Safe as Haven wallet / Safe

  Agent->>SDK: quoteX402(url) / haven_quote_x402
  SDK->>Resource: Probe paid resource (x402-wallet when known)
  Resource-->>SDK: 402 + PaymentRequired
  SDK-->>Agent: Parsed quote (read-only)
  Agent->>SDK: payX402Quote / haven_pay_x402_quote
  SDK->>SDK: Build merchant EIP-3009 X-PAYMENT locally
  SDK->>API: Create funding intent (Bearer identifies agent)
  API->>AM: Read allowance + delegate balance
  alt within allowance
    API-->>SDK: Unsigned funding hash + authenticated x402 context
    SDK->>SDK: Sign funding hash with local delegate key
    SDK->>API: Submit funding signature
    API->>AM: Relay signed Safe-to-delegate funding transfer
    AM->>Safe: Transfer within approved budget
    API-->>SDK: Funding transaction
    SDK->>SDK: Wait for at least one confirmation
    SDK->>Resource: Retry original request with X-PAYMENT
    alt merchant accepts
      Resource-->>SDK: Success + optional PAYMENT-RESPONSE
      SDK-->>Agent: Merchant response
    else merchant rejects after funding
      Resource-->>SDK: Error response
      SDK-->>Agent: x402_retry_rejected_after_funding
      Note over Agent,SDK: Reconcile; sweep if delegate funds are stranded
    end
  else remaining < amount ≤ remaining + delegate balance
    API-->>SDK: pending_approval + payment id + x402 context
    SDK->>SDK: Attach resumeState
    SDK-->>Agent: Tell user to approve in Haven and preserve resume state
  else amount > remaining + delegate balance
    API-->>SDK: 422 insufficient_funds / fund_safe_or_raise_allowance
    Note over Agent,API: No payment or approval is created
  end
```

Bearer authentication identifies the agent but is never payment authority. Both
the merchant header and the Safe funding payload are signed by the local
delegate key.

## Hosted Generic Split Flow

Hosted MCP is keyless, so the funding signature and merchant header signature
are local edge-signing steps. The diagram below is the **EIP-3009 shape** of
the generic decomposed path — since
[#2041](https://github.com/d-hinders/Haven-AI/issues/2041) it is one of two: a
delegation-rail account at a merchant advertising
`extra.assetTransferMethod: "erc7710"` takes the erc7710 shape recorded
immediately after it instead.

```mermaid
sequenceDiagram
  autonumber
  participant Agent as Agent runtime
  participant Resource as x402 resource server
  participant MCP as Hosted MCP (keyless)
  participant Signer as Edge signer / local key
  participant API as Haven backend

  Agent->>Resource: Request paid resource
  Resource-->>Agent: 402 Payment Required
  Agent->>MCP: haven_pay_x402_quote { payment_required }
  MCP->>API: Construct funding intent
  alt signable funding intent
    API-->>MCP: { payment_id, payload_hash, x402.expected }
    MCP-->>Agent: Unsigned funding context
    Agent->>Signer: haven_sign { payload_hash, x402_expected }
    Signer-->>Agent: { signature, x402_binding }
    Agent->>MCP: haven_submit { payment_id, signature }
    MCP->>API: Relay funding signature
    API-->>MCP: funding status
    Agent->>Signer: haven_x402_sign_header { payment_required, x402_binding }
    Signer-->>Agent: { payment_header }
    Agent->>Resource: Retry with X-PAYMENT
    Resource-->>Agent: 200 OK / merchant response
  else outside the on-chain budget
    API-->>MCP: refusal — no intent row, no payload_hash, nothing queued
    MCP-->>Agent: Stop and tell the user to raise the budget; do NOT poll
  end
```

> **What this branch used to say, and why it changed** (#2121). It read `else
> pending approval` and ended `Stop, notify user, poll status` — an
> approval-queue branch drawn inside the **live** flow, which the text below
> then says applies to the delegation rail too. Unlike the legacy two-leg
> diagram at the top of this file, deliberately kept as history under its own
> banner, this diagram documents behaviour a caller can invoke today, so a
> branch that cannot occur was rewritten rather than disclaimed.
>
> What actually happens on the branch is a **refusal, and it is rail- and
> scheme-specific**: on the EIP-3009 shape drawn here the delegation rail
> estimates the redemption, so the caveat enforcer's refusal surfaces as a
> `502` **with no intent row**; on erc7710 authorize pre-checks the live
> remaining budget and answers `403 delegation_budget_exceeded`
> ([#2082](https://github.com/d-hinders/Haven-AI/issues/2082)); the legacy rail
> answers `410` (#1986). None of the three writes anything, and none produces a
> `payment_id` to poll. The `pending_approval` branch retained in the hosted
> tool code is fail-closed cover for a row stored before the retirement
> (#2101/#2113) — its verdict is `stop_and_tell_user`, and no live rail mints
> the status that reaches it.

**The erc7710 shape of the same tools (#2041).** When the shared #1450/#1453
selector picks erc7710, `haven_pay_x402_quote` prepares a settlement child
instead of a funding intent and reports `settlement_scheme: "erc7710"` with
`settlement.funding_leg: false`. The sequence then loses two steps rather than
gaining any:

```text
haven_pay_x402_quote  → settlement child + settlement_scheme: "erc7710"
haven_sign            → { payment_id } only; the signer fetches the child
haven_submit          → { payment_id, signature, settlement_scheme: "erc7710" }
                        POST /x402/:id/settle → payment_header, tx_hash null
agent retry           → X-PAYMENT: <payment_header>
```

There is no `haven_submit` funding relay to confirm and **no
`haven_x402_sign_header` step at all** — Haven assembles the header, the
merchant redeems the `[child, budget]` chain, and the delegate EOA never holds
the money. The scheme is stated explicitly at both hops (reported at quote,
echoed at submit) rather than inferred, which is #1360's property applied to a
second entry point.

Before signing the funding hash, the edge signer checks payload-hash equality,
reconstructs the canonical payment/resource/merchant/amount/asset/network/expiry
context, verifies Haven's expected-context signature against its configured
trusted signer.

> **Every field in that context must be the value Haven SIGNED, not a locally
> preferred one.** The hosted MCP relays the context; it is never a second
> opinion about what it contains. `resource_url` is the worked example
> ([#1189](https://github.com/d-hinders/Haven-AI/issues/1189)): the backend
> signs `paymentRequired.resource.url`, and the hosted surface briefly preferred
> the accepted option's own `resource` when a merchant set one. The
> reconstruction then differed by one field and the signer refused — correctly,
> but with `authentication message is invalid`, which reads as a credential
> problem rather than a field mismatch. When a relayed field looks like it has
> two plausible sources, the signed one wins by definition. Before building the merchant header, it rejects expired context
and verifies that the live challenge still matches the recorded funded context.

### Expected context v1 / v2 — which payload may be signed (#1138)

The hosted flow above works on the **delegation rail** too, with one difference
that the signer, not the caller, enforces. On that rail the account validates
the UserOp's **EIP-712 typed data**, while `payload_hash` is the bare ERC-4337
hash — a different value. Binding only the hash would leave the edge signer
endorsing bytes it cannot check, which is the opposite of the property the
binding exists to provide.

So the expected context is versioned, and the version is *derived* from its
contents rather than announced:

| Version | Carries | Signer may sign |
|---|---|---|
| v1 | no `typedDataHash` | the bare hash (raw ECDSA) — legacy rail |
| v2 | `typedDataHash` | `sign_data.typed_data` (EIP-712) — delegation rail. Preferred transport (#1263): the signer fetches the exact payload itself via `GET /x402/:id/sign-context` when handed just `payment_id` — and the hosted x402 quote tools are accordingly **compact by default** (#1272): no `typed_data`/`typed_data_b64` in the response unless `include_signing_payload=true`. Fallback (#1255): re-run the quote with the same `idempotency_key` plus that flag (the replay returns the ORIGINAL sign_data, #1207), then relay `typed_data_b64` as one opaque base64 string, unchanged. All transports land in this same digest check |

The signer refuses the mismatch **in both directions**: raw-signing the hash of
a v2 intent (the account would reject that signature on-chain, after the intent
is claimed), and signing typed data under a v1 context (no commitment to what
is being signed). It then re-derives the digest from the typed data in hand and
requires it to equal the committed one, so the Haven-signed declaration covers
the exact bytes signed. `buildX402ExpectedMessage` puts the version in both the
header line and the signed payload, so neither context can be replayed as the
other.

A version outside the table is a **third** refusal, and the one an operator is
most likely to meet (#1143). The set a given signer understands is
`SUPPORTED_X402_EXPECTED_VERSIONS` in `packages/signer/src/core.ts`; anything else
fails closed before any content check, with an error naming the received version,
the signer's ceiling, and the fix. This is not hypothetical housekeeping: the
backend deploys continuously from `dev` while a signer reaches users only on a
merge to `main`, so a signer one release behind a context bump is a structural
state. The tool schema therefore accepts any positive integer for `auth.version`
and leaves the decision to the signer — a literal there is validated by the MCP
server *before* any handler runs, which is how the original v2 rollout produced a
raw Zod string instead of a Haven diagnosis. Widening the schema widened the error
path only; an unrecognised version was never signable and still is not. Symptom
strings per signer age are tabulated in
[`mcp-runtime-compatibility.md`](../operations/mcp-runtime-compatibility.md).

That refusal is still *reactive* — the agent learns by quoting and then failing
to sign. Since [#1155](https://github.com/d-hinders/Haven-AI/issues/1155) both
halves of the comparison are also available **before** anything is signed:
`haven_pay_x402_quote` and `haven_pay_mcp_tool` return
`signer_compatibility.x402_expected_context_version` (the version that quote will
emit), and the signer states the set it verifies at its own MCP `initialize`.
The comparison is necessarily agent-mediated — the two servers cannot introspect
each other, and only the client sees both handshakes — so this layer ships
information and a prompt, never a gate. A mismatch is **advisory**: nothing that
succeeded before fails now, and the signing-time refusal above remains the
enforcement point. See
[`mcp-runtime-compatibility.md`](../operations/mcp-runtime-compatibility.md#detecting-skew-before-a-payment-1155).

Delegation-rail UserOp signing is **local-signer-only** — the hosted/edge
keyless path never signs an account UserOp. That is a non-custody and CASP-scope
boundary (owner decision, 2026-08-06), not a sequencing preference.

## Hosted Paid-MCP-Tool Flow

Before the paid flow, `haven_quote_mcp_tool({ merchant_url, tool_name,
arguments? })` can return the live merchant/resource identity, amount in atomic
and display form, token/decimals, network/chain, timeout, and session transport
without creating an intent. It runs the same bounded, same-origin endpoint
discovery as the paid tool, and returns the resolved `merchant_url` when a base
URL was supplied. It deliberately returns no `payment_required`, `payment_id`,
signing context, cap/allowance guidance, or persisted call context. A later
`haven_pay_mcp_tool` must re-run the live quote and apply its own explicit cap
before creating any funding intent; the informational result cannot be reused as
a paid authorization.

The recommended three-call fast path for an x402-protected MCP tool is:

1. `haven_pay_mcp_tool` — hosted MCP establishes an MCP session (`initialize`,
   then `notifications/initialized`) and sends the unpaid, session-bound
   `tools/call` quote probe. It records the MCP transport context and returns
   the unsigned funding payload plus merchant/tool context.
2. `haven_sign_x402` — the local signer signs the funding hash and creates the
   merchant-bound payment header.
3. `haven_settle_mcp_tool` — hosted MCP relays the funding signature, waits for
   confirmation, performs a fresh merchant MCP handshake, delivers the signed
   header, and returns `agent_summary.purchase_summary` as the default report;
   raw `result` remains optional merchant evidence.

**Hosted header preflight (#1398).** Before step 3 relays the funding
signature, hosted MCP validates the bounded, signed `X-PAYMENT` header against
the agent-scoped persisted intent: payee, asset, network, atomic amount,
resource when the x402 version carries it, captured delegate payer, valid
authorization window, nonce shape, and EIP-712 recovery. A malformed,
unsupported, expired, or mismatched header fails closed with
`INVALID_PAYMENT_HEADER`; no funding is relayed, no merchant retry occurs, and
header values are not included in the error. This is an integrity preflight
only: it never rebuilds or alters the signature/header, persists it, or claims
merchant settlement. The merchant/facilitator remains the final verifier.

**Settle by `payment_id` (#1307).** `haven_settle_mcp_tool` and
`haven_complete_mcp_tool` accept `merchant_url` / `tool_name` / `arguments` /
`mcp_transport` as OPTIONAL. `haven_pay_mcp_tool` (step 1) persists the merchant
call context it was invoked with on the funding intent's existing
`machine_metadata` column (no migration — the same JSONB blob
`settlement_scheme` already lives in). Omitting those fields at settle time
makes Haven rehydrate them by `payment_id` via
`GET /x402/:id/merchant-call-context` — the settle-leg twin of the #1263
sign-context handoff, and the same rehydration precedent
(`rebuildDelegationSignContext`) extended to a second stored-state read. This
is convenience metadata for retrying the MERCHANT's own JSON-RPC call, never
payment authority: rehydration constructs nothing and cannot redirect funds,
only the outbound merchant HTTP call. Passing the fields explicitly remains
supported as the version-skew fallback (older signer/backend, or an intent
Haven never stored a call context for — e.g. a plain non-MCP-tool x402
resource, or the pre-#1307 shape). The endpoint refuses with the same
discipline as sign-context: unknown/foreign `payment_id` → 404 (never a
403-leak); no stored context, or an incomplete one → 409 naming the fallback;
the funding/quote window expired → 410 (lazy-expiring a still-pending row past
its window, exactly like #1263 — a row that already moved past
`pending_signature` stays servable for however long merchant delivery takes,
so a retry after a `MERCHANT_UNRESPONSIVE_AFTER_FUNDING` timeout is never
forced into a fresh, re-funding quote).

The decomposed alternative is:

```text
haven_pay_mcp_tool
  → haven_sign
  → haven_submit
  → haven_x402_sign_header
  → haven_complete_mcp_tool
```

If the merchant rejects after funding, hosted MCP returns
`MERCHANT_REJECTED_AFTER_FUNDING`. The delegate may hold stranded funds; retain
the payment id and inspect and reconcile the attempt before using
`haven_sweep_delegate`. Do not silently retry or abandon a confirmed balance.

## Guided Catalog Purchase Preflight (#1306)

Before this guided path, the agent can read the curated catalog through
`GET /catalog` or `haven_discover_tools`. That discovery surface is still
strictly read-only: `category` is matched case-insensitively after trim, the
optional `search` term matches `name`, `description`, or `category`, and the
existing `rail` plus agent-chain scoping still apply. Results stay
deterministically ordered and may be empty or multi-row; they never authorize
payment, and any catalog price remains indicative until the live quote below.

`haven_quote_catalog_purchase({ catalog_id })` is the read-only catalog wrapper:
it performs the same chain-scoped catalog lookup and usable-MCP-row guard, then
runs the same live merchant probe as `haven_quote_mcp_tool`. It returns the
generic quote fields plus the catalog identity and its price, explicitly marked
indicative. It creates no intent, approval, signing context, allowance check, or
price reservation. An unknown/degraded/non-MCP catalog row keeps the existing
manual fallback: use `haven_pay_mcp_tool` with an explicit merchant URL and
tool name. When ready to buy, call `haven_prepare_catalog_purchase` with a cap;
that paid preflight obtains a fresh live quote and checks the cap independently.
When the user stated no cap, the documented convention
([#1548](https://github.com/d-hinders/Haven-AI/issues/1548)) is quote first and
cap at the live quoted amount — never invented headroom; a price rise between
the two then refuses safely at the cap check and the agent re-confirms with
the user. Guidance only: the cap stays required and its enforcement is
unchanged.

`haven_prepare_catalog_purchase({ catalog_id, max_amount_human | max_amount, idempotency_key? })`
starts a paid-MCP-tool purchase from a curated `merchant_catalog` row instead
of a hand-copied `merchant_url` / `tool_name` / `tool_arguments`. It is a
convenience and verification layer built entirely from EXISTING primitives —
it composes, rather than duplicates, the `haven_pay_mcp_tool` internals: the
quote probe with the #1271 discovery fallback is shared via one
`quoteMcpToolCall` helper, and since
[#1547](https://github.com/d-hinders/Haven-AI/issues/1547) the settlement
scheme too — the guided path runs the same `selectX402SettlementScheme`
(#1453) `haven_pay_mcp_tool` runs, where before it was hard-wired to the 3009
funding leg (so the RECOMMENDED catalog route forced the fallback scheme while
the manual tool got the preferred one). On the delegation rail against an
erc7710-advertising merchant it composes the same `prepareX402Erc7710` call
(#1456) and returns the direct-settlement shape (`settlement_scheme:
'erc7710'`, `settlement.funding_leg: false`) plus the catalog fields and
allowance block; the signer flow is then `haven_sign` with `payment_id` alone
and settle carries NO `payment_header`. Otherwise it composes the same
`createX402Intent` call, and the response is the SAME compact ready-to-sign
shape `haven_pay_mcp_tool` returns (#1272: `payment_id`, `payload_hash`,
`expires_at`, `signer_compatibility`, `x402`) plus catalog fields — never a
third signing surface; the signer flow is `haven_sign_x402` with `payment_id`
alone (#1355: the signer's authenticated sign-context fetch also carries the
`payment_required` persisted on the intent's `machine_metadata` at authorize
time — the #1307 pattern applied to the sign leg; on a pre-#1355 backend the
signer asks for `payment_required` explicitly), then `haven_settle_mcp_tool`.
On BOTH schemes the `mcpCallContext` is persisted per #1307 (the erc7710
authorize accepts it too, #1547), so settle rehydrates the merchant call by
`payment_id` and the agent never re-threads merchant fields.

Sequence:

1. Load the catalog entry by `catalog_id` via `GET /catalog/:id`. Chain
   scoping comes free from the #1299 SQL (agent-authenticated reads add a
   `network = eip155:<agent.chain_id>` predicate) — an id that does not exist
   and an id curated for a DIFFERENT chain both 404 identically; nothing is
   re-filtered in JS.
2. Refuse a `degraded` row or one missing MCP tool metadata
   (`protocol`/`tool_name`) before any merchant probe, naming
   `haven_pay_mcp_tool` (with an explicit `merchant_url`/`tool_name`) as the
   manual fallback.
3. Run the LIVE quote against the entry's own `resource_url` / `tool_name` /
   `tool_arguments` — the shared probe, including the #1271 same-origin
   discovery fallback. **Round-trip budget (#1348):** the two Haven reads
   steps 5–6 need (agent, allowances) are independent of this probe, so they
   are DISPATCHED here and overlap the merchant leg — the slowest part of the
   preflight — instead of following it. Failure semantics are unchanged: the
   quote is awaited first (its error wins deterministically when several legs
   fail), the agent read remains a hard pre-intent refusal, and the allowance
   read still degrades to a warning. Additionally, `getAgent` coalesces
   CONCURRENT calls into one HTTP GET (in-flight dedupe only, never a cache —
   sequential calls stay fresh reads), and `createX402Intent` accepts the
   already-fetched `delegateAddress` instead of re-fetching the agent. Net: a
   successful preflight makes exactly ONE call per Haven surface — catalog,
   agent, allowances, `POST /x402` — enforced by round-trip-count unit tests
   (deterministic, unlike wall-clock); per-step wall-clock telemetry rides the
   promotion-gating QA scenario's pass detail.
4. A spending cap is **required** on this tool, as on `haven_pay_mcp_tool` —
   this IS the guided path, so there is no `cap_warning`
   softness. Enforced against the amount actually authorized — the option
   `selectX402SettlementScheme` selected, via the shared `priceSelectedOption`
   guard — never the unselected standard entry (#2051: the two selectors are
   mutually exclusive by #1453, so "the live quote" and "the amount authorized"
   are DIFFERENT `accepts[]` entries on the erc7710 branch, and a
   merchant-controlled 402 could steer the cap onto the cheap one while the
   expensive one was sent). Asserted before any intent exists, funding or
   settlement child (`PRICE_EXCEEDS_MAX`).

   **Two spellings, one cap (#1351).** `max_amount` is atomic units;
   `max_amount_human` is the same cap in whole tokens, so `"1"` means 1 USDC
   rather than 0.000001 USDC. Exactly one may be sent. The human form is
   converted using the decimals of the **selected option's own** asset
   (`resolveTokenFromAddress(option.asset, option.network)` inside
   `priceSelectedOption` — the same address→token binding that produces
   `token`) — never the unselected standard entry's, never a caller-supplied
   token name, never an assumed 6. Three refusals, all before any
   merchant probe, funding intent, or signature, and none of which can widen the
   on-chain budget:

   | Condition | Code | When it fires |
   |---|---|---|
   | Both fields sent | `AMBIGUOUS_MAX_AMOUNT` | Before any network call — even when the two agree |
   | Neither field sent | `INVALID_INPUT` | Before any network call (this tool only) |
   | Human cap unconvertible — unknown asset decimals, or more fraction digits than the asset holds | `MAX_AMOUNT_UNCONVERTIBLE` | After the live quote, before the funding intent |
   | A cap of **either** spelling was sent but no payment option is settleable, so there is no merchant-authoritative amount to compare it against (`haven_pay_x402_quote`) | `MAX_AMOUNT_UNCONVERTIBLE` | Before the funding intent |

   The unknown-decimals case is reachable rather than theoretical:
   `selectStandardPaymentOption` checks network and asset against separate sets,
   so Base-Sepolia USDC advertised on mainnet Base is selectable but resolves to
   no known token. `X402Quote.decimals` is `null` there and the human cap is
   refused; an exact atomic `max_amount` still works, since comparing it needs no
   decimals. `max_amount`'s meaning is unchanged for existing callers.
5. Read a rail-aware allowance/budget report via the EXISTING, already
   rail-aware `GET /machine-payments/allowances` (#1135) and the account's
   `execution_rail` (now also carried on `GET /machine-payments/agent`,
   #1306) — no new derivation logic. The response carries an `allowance`
   block: `{ rail: 'legacy' | 'delegation', sufficient: boolean | null,
   remaining_atomic?: string, source: 'allowance_module' | 'active_delegations'
   }`. A failed read degrades to `sufficient: null` plus a warning
   (`ALLOWANCE_CHECK_UNAVAILABLE`) — it never fails the preflight, since the
   on-chain policy remains the actual gate either way; this holds on BOTH
   rails, including the delegation rail's no-approval-queue branch below
   (#1319: `sufficient` degrades to `null`, never a fabricated `false`, so
   step 6's strict `=== false` refusal guard does not fire on a failed read).
   On the delegation rail specifically, a read can also SUCCEED on an
   OPTIMISTIC number: the on-chain enforcer read behind it
   (`readRemainingBudget`, #1145) deliberately falls back to reporting the
   full configured budget — never throwing — when the RPC read itself times
   out, so this preflight's failed-read branch never fires for that failure
   mode. The wire now carries that provenance
   (`onchain.remaining_is_from_chain`, additive/optional, delegation-rail
   only), and when it reads `false` this preflight adds a second, distinct
   warning (`ALLOWANCE_READ_OPTIMISTIC`) alongside a real `sufficient`
   true/false — the reported remaining budget could not be read live from
   chain and is the configured full budget, not a confirmed figure; the
   on-chain policy (the budget caveat enforcer) remains the actual gate at
   redemption regardless.
6. Rail behavior differs deliberately: on the **legacy** rail, an
   insufficient allowance does NOT refuse here — the flow proceeds exactly
   like `haven_pay_mcp_tool`, and the resulting funding intent queues for
   wallet-owner approval (`pending_approval`). On the **delegation** rail,
   there is no approval queue (#1090) — an over-budget quote REFUSES right
   here, before any funding intent is created
   (`DELEGATION_BUDGET_EXCEEDED`, `next_action: fund_safe_or_raise_allowance`),
   rather than letting a later on-chain redemption revert.
7. `createX402Intent` runs identically to `haven_pay_mcp_tool`, persisting
   the same `mcpCallContext` (#1307) for settle-leg rehydration by
   `payment_id`.
8. The catalog's `price_atomic`/`price_display` are surfaced as
   `catalog_price_atomic`/`catalog_price_display` with
   `catalog_price_is_indicative: true` — NEVER authoritative. The amount actually
   being authorized (`amount`/`amount_atomic`/`token`, from the selected
   option — the quote's own price only on the EIP-3009 branch, #2051) is
   authoritative; a `CATALOG_PRICE_DIFFERS` warning fires when the two
   disagree.

No new backend endpoint was needed: `GET /catalog/:id`, `GET
/machine-payments/agent`, `GET /machine-payments/allowances`, and `POST
/x402` are all existing, composed reads/writes. `GET /machine-payments/agent`
gained one additive field (`execution_rail: 'legacy' | 'delegation'`) so the
hosted tool can label the allowance block correctly without a second
derivation.

## Post-Purchase Allowance Summary (#1310)

`haven_settle_mcp_tool`'s `settled: true` branch, and `haven_get_payment_status`
for a genuinely settled x402 payment (`rail: 'x402'`, `phase:
'payment_confirmed'` — `funded_but_unsettled` is deliberately excluded, since
that phase means the merchant did NOT accept the paid retry), carry an
`allowance` field: a rail-aware remaining-spend summary so the agent can
report budget to the user without a separate `haven_get_agent` /
`haven_get_allowances` round trip. No new backend endpoint here either — the
SDK's `HavenClient.getPostPurchaseAllowanceSummary(paymentId)` resolves the
settled token from `getPaymentStatus`, then reads through the EXACT same path
as `getAllowances()` / #1306's preflight `allowance` block (`GET
/machine-payments/agent` + `GET /machine-payments/allowances`; delegation-rail
values are the #1090 `deriveDelegationBudgets`-backed enforcer read, never
`agent_allowances`) — so it can never disagree with `haven_get_allowances` for
the same fixture. Shape:

```text
{ rail: 'legacy' | 'delegation', remaining_atomic: string,
  remaining_display?: string, token_symbol?: string, token_address?: string,
  reset_period?: number, source: 'allowance_module' | 'active_delegations' }
```

Deliberately the SAME rail-labeled spelling as #1306's `allowance` block,
minus the preflight-only `sufficient` field — post-purchase reporting answers
"what is left", not "was this purchase covered". This is read-only reporting,
never a spend authority claim: the on-chain policy (AllowanceModule or the
active delegation's caveat enforcers) remains the actual gate regardless of
whether this summary can be produced. A failed read (payment-status lookup,
agent lookup, or the allowance/budget lookup itself) NEVER converts a
succeeded settlement into a failure — `getPostPurchaseAllowanceSummary`
degrades to `{ allowance: null, warnings: [ALLOWANCE_CHECK_UNAVAILABLE] }` —
and so does a SUCCESSFUL read where no allowance/budget row matches the
settled token (#1320 review: unknown is reported as unknown, never a
fabricated zero) —
folded into the response's existing `warnings[]` (#1308). `ALLOWANCE_CHECK_UNAVAILABLE`
predates this issue (#1306) and is reused rather than respelled; per #1318 it
was confirmed SDK-side only, never mirrored on the backend.

Freshness caveat (#1319): the delegation rail's on-chain enforcer read can
silently fall back to the optimistic full period budget without throwing when
the RPC read itself fails (the pre-existing #1145 design, deliberately
unchanged by #1319 — the fallback stays fund-safe). The underlying wire now
carries the provenance (`onchain.remaining_is_from_chain`, #1319), but this
summary — unlike the #1306 catalog-purchase preflight above — does not yet
surface it as a warning; `remaining_atomic` still reflects the last successful
chain read, not a guaranteed-live one, and phrasing here avoids claiming
freshness.

## Resuming An Authorized Payment

> ⚠️ **The approval-queue resume this section used to describe NO LONGER
> RUNS** (#2121, epic #1440). It narrated a queue — *"Haven queues a pending
> approval"*, *"tell the user the payment is waiting in Haven"*, *"the user
> approves and executes the Safe funding transaction"*, then a poll through
> `pending` → `approved` → `proposed` → `executed`. **None of those four
> statuses is constructible.** `payment_intents.status` has a five-literal
> write domain (`pending_signature | submitted | confirmed | expired |
> failed`); the four polled here were `approval_requests` statuses, and #2055
> dropped that table and its route. The proof is structural and pinned in
> [`modules/payments/__tests__/status-domain.test.ts`](../../packages/backend/src/modules/payments/__tests__/status-domain.test.ts)
> — cite it rather than re-deriving the argument. An agent implementer
> following the old text would have written a polling loop for a state no code
> produces.
>
> Deleted rather than kept as history, because — unlike the legacy two-leg
> diagram this file banners at the top — it was step-by-step instruction for
> an integrator, not a record of a flow. What replaces it below is the state of
> the two things that were never approval-specific, stated separately because
> they differ: context rehydration, which is live, and the resume call itself,
> which since #2145 has a reachable, server-derived trigger.

**What is live: rehydrating stored context.** If the process restarted and only
the payment id remains, call `getResumeState(paymentId)` to rehydrate Haven's
stored x402 context. It is a plain read with no status precondition, and it is
rail-neutral. Haven stores payment context, not the agent's local request
stream, so request bodies, tool names, and tool arguments may still need to be
preserved or reconstructed. SDK and hosted MCP tool completion establish a
fresh MCP transport session; callers do not need to preserve the old session
id. Local MCP normalizes most fields to camelCase while retaining
`resume_state`; backend HTTP responses use snake_case.

**What is live since #2145: the resume CALL, with a reachable trigger.**
`resumeX402Payment` / `haven_resume_x402_payment` (and `resumeAuthorizedX402`
beneath them) are gated by `assertCanResumeX402`
([`packages/sdk/src/x402-protocol.ts`](../../packages/sdk/src/x402-protocol.ts)),
which hard-requires `nextAction === retry_original_x402_request` and throws
otherwise. That value now has exactly one producer, and it is server-side:

1. The backend's status projection
   ([`modules/payments/agent-payment-status.ts`](../../packages/backend/src/modules/payments/agent-payment-status.ts),
   `intentStateFor`) answers `phase: funded_but_unsettled`, `next_action:
   retry_original_x402_request` for a **confirmed x402 EIP-3009 intent whose
   merchant leg was never reported** — no
   `machine_payment_evidence` row upgraded past the server-written
   `payment_confirmed` base — once a grace window
   (`MERCHANT_REPORT_GRACE_MIN`, 15 minutes after the funding confirmation)
   has passed. This is the crash shape: the agent died between the funding
   leg confirming and its own merchant retry, value sits on the delegate EOA,
   and the merchant was never paid. Before #2145 this exact state answered
   `next_action: none` — *"The payment is confirmed."*
   The #2159 QA deployment may set `MERCHANT_REPORT_GRACE_MIN_OVERRIDE=0` only
   when it serves **only Base Sepolia** (`HAVEN_DEPLOY_CHAIN_IDS=84532`); startup
   refuses that override on mainnet, mixed, or unbounded deployments, so the
   production 15-minute protection cannot be shortened accidentally.
2. The derivation is entirely from evidence Haven holds server-side
   (`merchant_leg_reported` in the status projection SQL,
   [`infra/repositories/payment-intents.ts`](../../packages/backend/src/infra/repositories/payment-intents.ts))
   — deliberately **not** from the client-written
   `merchant_retry_rejected_after_payment` reconciliation event, whose only
   producer is an agent that survived to report its own failure. That event
   still has its own meaning: when it exists, the retry was **tried and
   refused**, and the answer is `sweep_stranded_funds` instead. The two
   states are self-consistent — a resumed retry that the merchant rejects is
   recorded by the SDK and flips the answer from retry to sweep.
3. The consuming path is unchanged from what #2131 verified:
   `resumeAuthorizedX402` reads **`GET /machine-payments/:id/status`**, and
   `mapPaymentStatusResult`
   ([`packages/sdk/src/payment-mappers.ts`](../../packages/sdk/src/payment-mappers.ts))
   passes `next_action` through verbatim, so the guard reads the backend's
   verdict directly.

Scope worth stating: the trigger fires only for `settlement_scheme:
'eip3009'`. On erc7710 there is no funding leg — `confirmed` *is* merchant
settlement — and an intent with no scheme metadata fails closed to the plain
`confirmed` answer. The residual ambiguity is a delivered payment whose
best-effort evidence upgrade never reached Haven: it reads as undelivered and
is told to retry a merchant that was already paid, which is the safe side —
x402 merchants answer a re-request of a settled purchase idempotently
(#1519).

**Historical record (#2131/#2145), kept because both states shipped.** From
the approval queue's removal (#2055) until #2145, this value had **no
producer at all**: the backend never emitted it, and the SDK's only mapping
to it — `executed` → `retry_original_x402_request` in `nextActionForStatus`
— read a status that cannot be constructed (`executed` was an
`approval_requests` status; the table is dropped). Thirteen agent-facing
sites nonetheless instructed agents to gate on it, which #2131 removed; with
the producer now real, those sites advertise the trigger again, accurately.
#2145 also resolved the `executed` mapping itself the way #2101 treated its
siblings: fail-closed to `stop_and_tell_user`, because the reachable
producer is the backend projection arriving via `next_action`, never a
client-side status fallback. (An earlier draft of the #2131 analysis said
`'executed'` "does not appear anywhere in backend production code", which
was false — `packages/core/src/machine-payment-lifecycle.ts` compares
against it in a live, vacuous branch; caught by `haven-doc-reviewer` on
#2131 and kept here as a scope-of-grep lesson.)

## Which Address A Merchant Sees, And Mapping It Back (#1472)

On erc7710 the merchant-visible payer is **the agent's delegate account** — the
`delegator` of the settlement child in the `X-PAYMENT` header. It is neither
the treasury (where the funds provably leave: the ERC-20 `Transfer.from` is the
owner's account) nor the signing EOA. All three are distinct addresses, and a
receipt or dispute will usually carry the middle one.

To map a merchant-visible payer back to a Haven agent:
`GET /machine-payments/agent` returns `delegate_account_address` for
delegation-rail agents — a pure derivation (the counterfactual Hybrid address
of the signing EOA), `null` on the legacy rail. Match the receipt's payer
against it; no delegation-chain reading required.

The demo merchant's own receipt labels the address for what it is
(`delegatkonto — betalningen dras från ägarens treasury`) rather than implying
custody it does not have. Third-party merchants will print whatever they
print — which is exactly why the API-side mapping exists.

## Differences From Direct Payments

| Concern | Direct `/payments` | x402 |
|---|---|---|
| Payment target | Recipient address from agent intent | Merchant `payTo` from HTTP 402 challenge |
| Amount units | Human decimal string | Atomic amount from x402 option |
| Agent action after funding | None for direct confirmed payment | Retry original merchant/resource request |
| Header sent to merchant | None | `X-PAYMENT` |
| Payment authority | Delegate signature + on-chain allowance | Same for funding leg; EIP-3009 signature for merchant leg |
| Restart recovery | Fetch payment status | Rehydrate stored x402 context by payment id (`getResumeState`); resume when status answers `retry_original_x402_request` (#2145) — see [Resuming An Authorized Payment](#resuming-an-authorized-payment) |

The `payment_intents` INSERTs are the SAME
rail-agnostic `infra/repositories/` writers the mpp module uses for its own
rails (`modules/mpp/`, #997) — `modules/x402/delegation-authorize.ts` calls
them directly rather than through
a `lib/machine-payments.ts` pass-through (removed by #997: it added no logic
over the repository call and kept x402 coupled to a private mpp file once
mpp's own orchestration moved into its module). This sentence named an
`approval_requests` writer alongside `payment_intents` until #2121; there is no
such writer — `infra/repositories/approval-requests.ts` was deleted with its
table by #2055, as the Guardrails section below already records. Token
resolution (`resolvePaymentToken`) is genuinely shared between the two modules
and lives in `src/domain/payment-token.ts` for the same reason.

## Delegation rail x402 (new accounts)

On the delegation rail (#830, epic #821) there is **no funding leg and no delegate
EOA to strand**. The agent's budget delegation *is* the settlement instrument:
funds move `account → merchant` directly, and the on-chain caveat enforcers meter
the period budget as part of the settlement itself.

The flow is a two-call variant of `/x402/authorize`:

1. `POST /x402/authorize` resolves the account's rail from agent auth. For a
   delegation account it builds a **settlement child delegation** and returns the
   EIP-712 `typed_data` the agent must sign — not an AllowanceModule funding hash,
   and it never queues an approval (over-budget/wrong-recipient reverts on-chain).

   **An over-budget amount is refused here, before the child exists**
   ([#2082](https://github.com/d-hinders/Haven-AI/issues/2082)). Authorize reads
   the selected budget delegation's live remaining period budget — the same
   `ERC20PeriodTransferEnforcer` storage read `GET /machine-payments/allowances`
   performs (#1145) — and answers `403` `delegation_budget_exceeded` with
   `phase: insufficient_funds`, `next_action: fund_safe_or_raise_allowance` and
   the shortfall, writing nothing and deploying nothing.

   Read this as a fail-fast convenience, **not a policy boundary**, and the
   distinction is the whole point. The caveat stack is still the gate: it
   refused an over-budget redemption before this check existed and refuses one
   now, and nothing here widens what the chain will allow. What changed is
   *when* Haven says no. Previously this branch prepared nothing at authorize —
   unlike `POST /payments` and the EIP-3009 shape, which estimate a redemption
   and so surface the enforcer's refusal as a `502` with no intent row — so an
   over-budget erc7710 request came back `201 pending_signature` **with**
   `sign_data`, and the refusal only landed after the agent had signed, settled,
   and retried the merchant. Since [#1450](https://github.com/d-hinders/Haven-AI/issues/1450)
   made erc7710 the preferred scheme, the path most payments take was the one
   that refused latest.

   The check **fails OPEN**: `readRemainingBudget` reports `fromChain: false`
   when the enforcer read failed or the delegation carries no period caveat it
   can speak for, and a fallback number never refuses a payment. Refusing on a
   degraded RPC read would turn a transient outage into a stopped agent, which
   is the same posture as #1145's fallback and #1319's `remaining_is_from_chain`
   honesty flag. The EIP-3009 branch is deliberately untouched — it already
   refuses at authorize, and a second pre-check there would be a second source
   of truth for one condition.

   Before the intent is created, authorize also **deploys the child's delegator —
   the delegate hybrid account — if it is still counterfactual**
   ([#1667](https://github.com/d-hinders/Haven-AI/issues/1667)): the
   DelegationManager verifies the child's signature via EIP-1271 when the
   delegator has code and ecrecover when it does not, so against an undeployed
   account the delegate EOA's signature recovers to the EOA ≠ delegator and
   redemption reverts `InvalidEOASignature`. The EIP-3009 bridge deploys the
   account as a side effect of its first funding UserOp's initCode, which is why
   the gap surfaced only for a fresh agent whose *first* payment is erc7710 —
   and would have been permanent for recipient-pinned agents, which can never
   run a 3009 leg. The deploy is the same permissionless, relayer-paid factory
   call as treasury activation (#860, `ensureHybridDeployed`), short-circuits on
   a single `getBytecode` once deployed, counts against the relayer gas budget
   (#717 → 429), and fails closed with a retryable 502 before any intent row
   exists.
2. The agent signs that typed data VERBATIM with its delegate key (the #829
   lesson) and submits `{ signature }` to `POST /x402/:id/settle`. Settle
   **recovers the signer** from the child delegation's EIP-712 payload and
   compares it to the agent's `delegate_address` *before* the intent status
   flips ([#1053](https://github.com/d-hinders/Haven-AI/issues/1053) review,
   finding 3). A malformed signature or one from the wrong key is a `400` with
   the intent left signable — the client re-signs the same `sign_data`; nothing
   is burned. (Recovery lives in
   [`rails/delegation-policy.ts`](../../packages/backend/src/rails/delegation-policy.ts)
   as `recoverDelegationSigner`, not in the route: `routes/**` may not import
   viem under the chain-SDK boundary rule.)
3. Haven assembles the merchant-facing `X-PAYMENT` header using MetaMask x402's
   `erc7710` payload
   (`{ delegationManager, permissionContext, delegator }`
   — [`x402-delegation.ts`](../../packages/backend/src/modules/x402/x402-delegation.ts)).
   The agent retries the merchant with that header, and the merchant settles the
   payment directly from the account through the DelegationManager.

   The response also carries `passport` — `{ attestation_uid, chain_id }` (plus
   an optional convenience `verify_url`) or `null`
   ([#976](https://github.com/d-hinders/Haven-AI/issues/976)),
   so the agent can PRESENT its passport rather than have the merchant discover
   it. It is deliberately **outside** the `X-PAYMENT` payload: that payload is
   parsed by a facilitator Haven does not control, and an unrecognised key is a
   rejection risk. `null` whenever nothing is verifiable, and a lookup **error**
   never fails the payment (it degrades to `null`; a lookup *hang* is a
   different case, handled by ordering the lookup before the status `UPDATE`).
   On the EIP-3009 path the reference cannot ride the
   payment at all — see the delivery matrix in
   [`11-agent-passport-schema.md`](11-agent-passport-schema.md).

The intent moves to `submitted`. `POST /x402/:id/settle` is Base-only and, as of
this writing, sits on the OpenAPI drift check's `KNOWN_UNDOCUMENTED_ROUTES`
allowlist pending the epic docs sweep (#834). Operational detail (gas sponsorship, vendor
dependencies): [`delegation-rail-vendor-ops.md`](../operations/delegation-rail-vendor-ops.md);
security model: [`delegation-rail-security-model.md`](../security/delegation-rail-security-model.md).

#### Completing an erc7710 settlement (#2092)

`submitted` is where the intent used to STOP. Haven submits nothing on this
scheme, so nothing flipped it to `confirmed` and it never acquired a
`tx_hash` — and every downstream surface is keyed on exactly that pair:
`recordMachinePaymentEvidenceBase` (book-time FX in `amount_sek`, the
fee-ledger row, and `feedSettledPaymentBestEffort`), `GET /receipts`,
`POST /machine-payments/:id/merchant-receipt`, and dashboard transaction
history. erc7710 payments were therefore absent from the Fortnox reporting
feed and from the UI, while EIP-3009 payments reached both.

The completion seam is **scheme-agnostic by construction**: no consumer knows
about schemes. `POST /machine-payments/evidence` — the call the SDK already
made after a successful paid retry — gained one pre-step
([`modules/x402/settlement-observed.ts`](../../packages/backend/src/modules/x402/settlement-observed.ts)).
When the reported payment is a `submitted`, delegation-rail,
`settlement_scheme: 'erc7710'` intent with no hash, the reported `txHash` is
**verified on-chain** and the intent is confirmed; from that point it is
indistinguishable from a 3009 intent and the existing pipeline runs unchanged.
On every other shape the pre-step is a no-op, so eip3009 and the legacy rail
keep exactly the transitions they had.

**What the hash is checked against.** The hash is client input on a path that
ends in the user's bookkeeping, so
[`infra/chain/settlement-transfer-verifier.ts`](../../packages/backend/src/infra/chain/settlement-transfer-verifier.ts)
requires ALL of: the tx is mined on the intent's own chain; its receipt status
is success; it carries an ERC-20 `Transfer` log emitted by the intent's token
contract, `from` the payer smart account, `to` the merchant `payTo`, for
**exactly** the authorized atomic amount; and the mined block's timestamp falls
inside **this intent's own settlement window** (the settlement child's
`timestamp` caveat is enforced on-chain, so a genuine settlement of this child
cannot be mined outside `authorize .. authorize + 600s`).

Since [#2094](https://github.com/d-hinders/Haven-AI/issues/2094) there is a
check 8, and it is the only one about WHICH payment rather than what shape it
had: when the transaction carries `RedeemedDelegation` logs from the **pinned**
DelegationManager, the emitted `Delegation` struct is re-hashed with the
framework's own `hashDelegation` and this intent's stored `delegation_hash`
must be among them; if it is not, the transaction demonstrably settled a
different payment and is refused. It is deliberately conditional and can never
turn a genuine settlement into a refusal — no stored child, no manager pinned
for the chain, or no decodable log from it means check 8 is skipped and the
verdict is checks 1–7 exactly as before. An absent log is "we learned nothing
here", not evidence of a forgery.

Deliberately NOT checked: the facilitator's DelegationManager **calldata**
(facilitator-specific and opaque — the Transfer log is the settlement's
universal EFFECT, and the caveat enforcers already bounded on-chain what could
move; check 8 reads the pinned manager's fixed-ABI EVENT instead, which is why
it adds no coupling to any facilitator), the submitter identity (redemption is
permissionless; who paid the gas is not an integrity property), and reorg depth
beyond one confirmation.

**The child is intent-unique (#2094).** The settlement child is salted with
`keccak256("haven-x402-settlement:" || <payment intent id>)`, and the intent id
is generated BEFORE the child is built and written as the row's explicit
primary key. Two authorizations that share merchant, token, amount and expiry
second therefore no longer produce a byte-identical child: their `childHash`
values differ, their `RedeemedDelegation` logs differ, and check 8 above can
name exactly one of them. The salt is **derived, never random** — the mapping
intent → child is a pure function of stored data, so a verifier (and a future
passive settlement sweeper) can recompute the child it should look for from the
intent row alone rather than trusting an opaque column. Nothing sensitive
reaches the chain: the preimage is a domain tag plus a v4 UUID that is already
the public `payment_id`, it is hashed so it is not legible on-chain anyway, and
the domain tag makes a collision with a budget-delegation salt
(`haven-delegation:…`, `rails/delegation-policy.ts`) structurally impossible.

**Ambiguity is still refused, never guessed.** Checks 1–7 are about the
transfer's SHAPE and its window; only check 8 is about WHICH intent, so the
guard that refuses to place an unattributable settlement is **kept** — narrowed,
not deleted. A look-alike `submitted` erc7710 twin of the same
agent/chain/token/recipient/amount, close enough in time for the two settlement
windows to OVERLAP, still refuses the confirm and leaves **both** `submitted`,
UNLESS all three hold: check 8 bound this settlement to this intent's own
child, this intent has a recorded child, and the twin has a recorded child that
is a DIFFERENT one. A twin whose child was never recorded is *unknown*, and
unknown is ambiguous rather than different — spelled out as two `IS NOT NULL`s
plus `<>` precisely so `IS DISTINCT FROM` cannot read NULL as "a different
child". The overlap reach is unchanged and still wider than one window — a
window is `[t - skew, t + M + skew]`, so two of them intersect whenever their
authorize times are within `M + 2 * skew`, not `M + skew`
(`AMBIGUITY_WINDOW_SECONDS`); sizing it to one window's own forward reach would
leave a skew-wide band of genuinely overlapping look-alikes unguarded. A missing
book entry is recoverable; a wrong one is not.

**In-flight authorizations are unaffected.** An authorization created before
#2094 and settled after it carries the old constant salt, and its stored
`delegation_hash` was taken from that child; the verifier re-hashes what the
chain EMITS rather than what today's builder would build, so it binds exactly as
a new child does. Two such pre-#2094 look-alikes share one child hash, fail the
"different child" conjunct, and are still both refused — which is the correct
answer for them, and the reason the guard is kept rather than removed.

**Fail closed, in every direction.** Anything short of a full match leaves the
intent `submitted` with no evidence row, no fee row and no feed call. An
unreachable RPC — including a receipt that reads back but whose block does not —
is reported as `503` (retryable — "not known yet"), never as a confirmation and
never as a permanent rejection; a revert, a mismatch, or an ambiguous
attribution is `409`. **Replay:** one settlement transaction may confirm at most
one intent — the guarded `UPDATE` refuses a hash already carried by another row,
serialized by a per-hash `pg_advisory_xact_lock`.

#### Completing a settlement nobody reported (#2117)

When the merchant returns no `PAYMENT-RESPONSE` transaction, or the generic
plain-HTTP erc7710 flow (#2041) means Haven never sees the header at all, no
hash is ever reported and the section above never runs. Those payments used to
stay `submitted` forever — settled money, permanently absent from the books.
[`modules/x402/settlement-sweeper.ts`](../../packages/backend/src/modules/x402/settlement-sweeper.ts)
is the leader-gated tick that completes them.

**It runs attribution in the reverse direction, on the same evidence.** The
reported-hash path asks "given this hash, is it this payment?"; the sweep asks
"given this payment, which transaction settled it?" — and answers it by looking
this intent's stored `delegation_hash` up in the pinned DelegationManager's
`RedeemedDelegation` logs over a bounded block range, then handing the
transaction it finds to the very same seam, which re-runs checks 1–8 and the
guarded `UPDATE` unchanged. #2094 is what makes this possible at all: the child
is salted from the intent id, so the lookup key is intent-unique and
recomputable from the row.

**There is deliberately no second attribution path, and this is the load-bearing
decision.** The sweep never proposes a candidate from transfer shape, and it
passes `requireDelegationBound`, so the seam refuses even a shape-perfect match
inside the right window when the pinned manager did not name this payment's
child. The reasoning is about which failure is worse on an accounting feed:
today's behaviour is *fail-closed — never wrong, sometimes missing*, and a sweep
that guessed would trade it for *sometimes wrong*. A missing row is found at
reconciliation; a confidently misattributed one is not. So the sweep completes
what the chain can name and refuses everything else.

**The window bounds the transaction; it does not bound the search.** A
settlement of this child cannot be mined outside `authorize .. authorize + 600s`
— the `timestamp` caveat fixes that on-chain, forever, and check 7 still
enforces it. How long Haven keeps *looking* is a separate, much wider bound (24
hours). The distinction matters because the likeliest real failure is an RPC
outage spanning a payment's window: if the sweep only ever considered live
windows, that payment would be lost for good and the gap would merely have
moved. Searching further back is not less safe — check 7 is unchanged — it only
costs more history.

**Cost and outages.** Each candidate is scanned over **its own** settlement
window — a few hundred blocks, where its transaction provably is — so no
candidate's coverage depends on any other's. That matters because the residual
gaps below are permanent for the payments they affect while the database still
returns them as candidates for a full day: a design that let the oldest
candidate anchor one shared range would let a single stuck row freeze the scan
short of the chain head and starve every newer payment on that chain. Overlapping
windows share their `eth_getLogs` calls (one per 500-block batch, filtered by the
pinned manager address and the redemption topic), a hard budget of 20 batches per
chain per tick applies, a candidate the budget did not reach is left untouched
rather than judged, an exponential backoff keeps a fruitlessly-scanned candidate
from spending the budget every tick, and a 90-second grace means the ordinary
agent-reported completion happens first so the sweep costs nothing on the happy
path. **Any** RPC failure
— an unreadable head, a failed batch — abandons the whole scan for that chain
and returns "not known yet": nothing is confirmed, nothing is marked failed, and
there is no in-tick retry, so a dead RPC cannot become a hot loop. A partial log
index is never used, because "hash absent from a truncated range" is
indistinguishable from "not settled".

**Accepted residual gaps.** Three, and all three stay `submitted` with no
evidence row rather than being guessed at. (A *fourth* state — `confirmed` with
no evidence row — is not in this list because it is not accepted: see the
recovery pass below.) Each is logged as an operational
warning once its settlement window has closed, so the residue is visible rather
than silent:

1. **A facilitator route that emits no decodable `RedeemedDelegation` log** from
   the pinned manager. Nothing on-chain names the payment, and transfer shape is
   not an answer to "which payment".
2. **A pre-#2094 look-alike pair.** Two authorizations that predate the salt
   share one child hash, so the ambiguity guard's "different child" conjunct
   fails and both stay refused — exactly as #2096 refuses them, and correctly.
3. **A settlement older than the 24-hour recovery horizon**, i.e. an outage
   lasting longer than a day. This is the residual that replaces "any unreported
   settlement is invisible forever", and it is a great deal narrower.

An agent on the plain-HTTP flow can still complete its own payment at any time
by posting the settlement hash to `POST /machine-payments/evidence`; and since
#2117 the SDK no longer discards the backend's retryable `503`
(`settlement_unobservable`) — it retries with bounded backoff, so a settlement
that simply had not been mined yet at report time no longer costs the payment
its place in the books.

**That remedy now travels with the alert (#2214).** The residual warning used to
end at "it will not reach the accounting feed", which overstated the situation
in the same way #2213's PR found one level down: it is the *sweep* that is
stuck, not the payment. The agent-reported path runs the same verifier with
`requireDelegationBound` **off**, so it does not need the manager log the scan
could not find (gap 1) and is not bounded by the recovery horizon (gap 3). The
log therefore carries a `remedy` field naming that route, because an alert about
a dead end is an alert operators learn to scroll past.

**The one exclusion that happens in SQL, and why it is not a fourth residual.**
`FIND_SWEEPABLE_ERC7710_INTENTS_SQL` requires `delegation_hash IS NOT NULL`,
upstream of the tick — so a row it dropped would be neither completed nor
counted in `unresolved` nor logged, missing both halves of "complete what can be
attributed, and log the rest loudly". @PhilipEriksson raised exactly that on PR
#2134 and #2136 pinned the behaviour. It is not a live gap, because the
population is unconstructible rather than merely empty: the sole production
writer of `settlement_scheme = 'erc7710'` sets `delegation_hash` in the *same*
`insertMachineIntent` call — one INSERT, both columns — and has done so since
#830 introduced the erc7710 path (2026-07-10), not since #2094 (2026-08-27).
What #2094 changed is the child's **salt**, so a pre-#2094 intent carries the
old constant-salt hash, is a candidate, is scanned, and is counted and logged
like any other; when a look-alike twin makes it unattributable it appears above
as residual gap 2. So `delegation_hash IS NOT NULL` is defence in depth over an
empty set. A counter or census for it would report zero forever; what is pinned
instead — from both directions, in
[`erc7710-sweep-eligibility.test.ts`](../../packages/backend/src/infra/repositories/__tests__/erc7710-sweep-eligibility.test.ts)
— is the invariant that keeps the set empty, so a second writer added without a
`delegationHash` fails a test rather than silently losing payments.

**The confirm and the evidence row are two writes, and the second one can fail
(#2213).** Completing a payment means flipping the intent `submitted →
confirmed` and then writing the `machine_payment_evidence` row that the
accounting feed enumerates. These cannot be one transaction and cannot be
reordered: `recordMachinePaymentEvidenceBase` refuses any intent that is not
already `confirmed` with a `tx_hash`, so evidence is settlement-time proof by
construction, and the write ends in a fire-and-forget call to the reporting feed
that no rollback could take back. Nor should the confirm be undone — it records
a true fact about the chain, and reverting it would re-open the replay/ambiguity
surface that the CAS exists to close.

The consequence is a fourth state, distinct from the three residuals above: a
payment that is `confirmed` with a hash and has **no evidence row**. It has left
the candidate query (`status = 'submitted'`) for good, and the feed's backfill
selects from evidence ROWS, so "Sync now" cannot see it either. Before #2213
nothing automated could reach it again, while the tick logged it as a
completion.

Be precise about the one path that was not closed: an agent re-posting the same
hash to `POST /machine-payments/evidence` WOULD still complete it —
`observeErc7710Settlement` answers `not_applicable` on an already-confirmed
intent, and `attachMachinePaymentEvidence` falls through to
`recordMachinePaymentEvidenceBase` and writes the row. The gap was never that a
retry would be refused; it was that nothing prompts one. The sweep reported
success, so no operator had a reason to look, and on the plain-HTTP flow (#2041)
the agent never had the hash to re-post in the first place.

Two things changed. The evidence seam now **reports** whether a row landed
(`recorded` / `not_applicable` / `failed`), so the tick counts `evidencePushed`
and `evidenceFailed` apart from the state transition `confirmed`, and a failure
is a `warn`, never the completion log. And a **recovery pass** runs each tick
over `FIND_EVIDENCE_ORPHANED_ERC7710_INTENTS_SQL` — confirmed erc7710 intents
with no evidence row, inside the same 24-hour horizon — and writes the missing
row. It touches no chain: those payments are already attributed. It re-derives
the hole from state rather than from a remembered failure, so it also recovers a
hole dug by the agent-reported path, and it is not scoped to `delegation_hash IS
NOT NULL` because recovery needs no lookup key. The one thing it cannot fix is a
settled payment with no `resource_url`, which `machine_payment_evidence`
requires NOT NULL: that is retried until the horizon and warned on every
attempt, so it announces itself rather than reporting success.

The distinction the seam draws is the crux. "Nothing to record" (wrong rail, not
settled yet) is a correct answer to a speculative caller and must not read as a
failure; "failed to record" (no resource URL, intent unreadable, write threw)
means a payment that should be in the books is not. Collapsing the two is how
the silence got there. At the sweep's own call site there is no legitimate
"nothing to record" left — it has just established every precondition itself —
so it treats every non-`recorded` outcome as a failure.

### What the settlement child delegation actually constrains

The child built by
[`x402-delegation.ts`](../../packages/backend/src/modules/x402/x402-delegation.ts) is
issued to `ANY_BENEFICIARY` (`0x…0a11`) unconditionally. When the 402 names
facilitator addresses, the **redeemer caveat** — not the `to` field — is what
restricts who may redeem; pinning `to` to the first entry (the pre-#1061
behaviour) silently contradicted a multi-entry caveat and would have failed for
every facilitator but the first.

Since [#1058](https://github.com/d-hinders/Haven-AI/issues/1058) the redeemer
list IS populated in practice: the client forwards the 402 entry's
`extra.facilitatorAddresses` (MetaMask's erc7710 shape, validated 1–16
addresses) into `POST /x402/authorize`, the child's redeemer caveat is built
from the normalized addresses, and the **verbatim** strings are stored with the
settle state and echoed in the v2 X-PAYMENT header's accepted entry — required,
because @x402/core's v2 matcher demands the advertised `extra` as a subset of
the echo. The demo merchant advertises its settlement account this way, so the
QA leg exercises the pinned path end-to-end.

When a merchant advertises **no** facilitators there is nothing to pin and the
child remains a bearer instrument — whoever holds it can redeem it — within
hard bounds that are the actual guarantee:

- the **exact** payment amount (`erc20TransferAmount` scope),
- **pinned to the merchant** `payTo`,
- an expiry of **≤600 s**.

The ceiling of that exposure is "the merchant gets paid without delivering",
never loss of funds beyond the quoted amount.

### Settlement-scheme reality and the EIP-3009 bridge

Redeeming the `[child, budget]` chain requires **facilitator-side erc7710
support**, and adoption is still thin: as of the 2026-07 catalog probe, ≈every
real x402 merchant is **EIP-3009-only**. erc7710 alone therefore left
delegation-rail accounts (the default for new accounts) with no route to most
merchants — so the rail now selects a settlement scheme **per payment**
([#946](https://github.com/d-hinders/Haven-AI/issues/946), shipped and
live-proven 2026-07-18; design of record: RFC
[#791](https://github.com/d-hinders/Haven-AI/issues/791) §18 "B4-D").

**Which scheme a client should PREFER (#1450, owner decision 2026-08-15).**
Read this before the mechanism below, because the table describes how a client
*says* what it wants, not what it *should* want:

> Prefer erc7710 whenever the account is on the delegation rail and the merchant
> advertises `extra.assetTransferMethod: "erc7710"`; fall back to the EIP-3009
> bridge otherwise.

The reason is structural: erc7710 has no funding leg, so the stranded-delegate-
funds class ([#713](https://github.com/d-hinders/Haven-AI/issues/713) — hot
balances, sweeps, the delegate-balance monitor) is **absent** on the preferred
path rather than reconciled. Recipient-pinned budgets were already erc7710-only
(`modules/x402/delegation-authorize.ts`), so they become the ordinary case
instead of a special one.

**A testing consequence worth stating, because it cost a QA leg
([#1441](https://github.com/d-hinders/Haven-AI/issues/1441)).** The rule is
unconditional on the merchant side: if a merchant advertises erc7710 at all, a
delegation-rail client takes it, and the **funding leg never runs**. So a
scenario whose invariant is the funding-leg topology cannot be exercised
against a merchant that offers both — not because anything is broken, but
because the path is unreachable. `x402-hosted-mcp-signer` skipped permanently
for exactly this reason, and under `QA_REQUIRE_ALL_LEGS=1` that blocked the
whole suite from reporting green.

Testing the funding leg therefore requires a merchant product advertising
**eip3009 alone**. The demo merchant carries one for this purpose
(`PRODUCTS.vpn_legacy`, `settlementMethods: ['eip3009']`); it exists to keep
that path reachable and must not be widened to both methods.

This is a preference, not a merchant-reach claim: the adoption paragraph above
stands, which is precisely why the bridge stays. Epic
[#1450](https://github.com/d-hinders/Haven-AI/issues/1450) is making it
reachable from Haven's own clients, one step at a time — as of
[#1452](https://github.com/d-hinders/Haven-AI/issues/1452) the SDK **can sign**
the settlement child (`sign_data.signature_scheme: 'eip712_delegation'`, signed
verbatim via `signSettlementDelegationTypedData`), and as of
[#1453](https://github.com/d-hinders/Haven-AI/issues/1453) it **can choose**
the scheme: `selectX402SettlementScheme` is the single place the preference
rule lives, and `selectStandardPaymentOption` now skips erc7710-tagged entries
instead of returning them positionally. [#1454](https://github.com/d-hinders/Haven-AI/issues/1454)
joins them into `HavenClient.settleX402Erc7710()` — authorize (`payTo` = the
merchant) → sign the child → settle → the backend-assembled `X-PAYMENT` header,
which the caller replays on the merchant retry. As of
[#1456](https://github.com/d-hinders/Haven-AI/issues/1456) the same flow is
reachable from the **hosted MCP tool surface**, which is the topology a normal
agent uses: `haven_pay_mcp_tool` selects the scheme server-side (rail from the
account, capability from the merchant's `accepts[]`) and reports it, and
`haven_settle_mcp_tool` exchanges the signed child for the header. As of
[#1547](https://github.com/d-hinders/Haven-AI/issues/1547) the guided catalog
preflight (`haven_prepare_catalog_purchase`) runs the same selector — see the
Guided Catalog Purchase section above. As of
[#2041](https://github.com/d-hinders/Haven-AI/issues/2041) the roll-call is
complete: the **generic plain-HTTP** entry point runs it too, so
`haven_pay_x402_quote` selects the scheme and `haven_submit` gained an explicit
`settlement_scheme` for the settle leg. That closes the coupling where the
merchant TRANSPORT an agent used decided the settlement SCHEME it could reach —
which mattered most on plain HTTP, since that is where the catalog's real
merchants are. Note the
sequence inversion, because it is the whole substance of that wiring: on the
3009 path the agent's signature FUNDS the delegate and the header is built by
the local signer; on erc7710 the signature IS the settlement child and the
header comes back from Haven. So the settle tool branches before the funding
relay, not after it. Note what the SDK does NOT do
on this path: it builds no header locally and touches no funds, because the
backend assembles the MetaMask payload in `assembleSettlementPayload`.

As of [#2054](https://github.com/d-hinders/Haven-AI/issues/2054) the **quote
path itself is selection-aware**, which is what makes an **erc7710-ONLY**
merchant (no untagged `accepts[]` entry at all) reachable through the two MCP
purchase tools: `buildX402Quote` — the helper behind `haven_quote_mcp_tool`,
`haven_quote_catalog_purchase`, `haven_pay_mcp_tool` and
`haven_prepare_catalog_purchase` — no longer throws when
`selectStandardPaymentOption` finds nothing; it falls back to DESCRIBING the
erc7710 entry and labels which selector produced it (`acceptedScheme` on the
quote, surfaced as `accepted_scheme` / `erc7710_only` on the quote tools). The
selector's #1453 skip is untouched, and the 3009 settlement paths keep
re-selecting through it, so an erc7710-described quote can never leak into an
EIP-3009 authorization. The two purchase tools then refuse a **null scheme
selection** with `ERC7710_RAIL_REQUIRED` — the account's rail cannot settle
the merchant's only compatible entry, or (pay tool only) the rail could not be
read — before any pricing or intent, instead of falling through to a
"no compatible payment option" that blames the merchant. A merchant with
nothing payable of EITHER kind still gets exactly that pre-existing refusal,
where it is accurate. Cap coherence is preserved by construction: the
guaranteed-non-null selection removed the `?? quote.accepted` display
fallbacks, so the quote shown, the cap checked (`priceSelectedOption`), and
the amount authorized all read the SAME selected option (#2051's invariant).

**Still unproven end to end, and worth stating rather than assuming.** The
nightly `x402-erc7710-settle` QA leg exercises the RAW API and deliberately
excludes the SDK, so nothing yet demonstrates a full purchase through
`HavenClient` — including the property the path exists for, that the delegate
EOA's balance is unchanged across the flow. #1454 pins the request shapes;
[#1457](https://github.com/d-hinders/Haven-AI/issues/1457) is where the
topology gets proven with balances.

**#1453 also closed a live footgun on the EIP-3009 path**, worth recording
because it cost real funds to reason about rather than being hypothetical:
because the old selector ignored `extra.assetTransferMethod`, a merchant that
listed its erc7710 entry first made a client echo THAT option while signing a
standard 3009 authorization. The merchant rejects the mismatch cleanly — but on
the legacy two-leg the Safe→delegate funding transfer has already executed, so
the result is a stranded delegate balance for the sweep. Only our own demo
merchant's `accepts[]` ordering was holding it shut.

**How the scheme is chosen (the mechanism).** The `modules/x402/` authorize
orchestration (`scheme-selection.ts`, since #996) keys on the authorize
request's `payTo` shape — which is exactly the standard-x402 SDK contract, so
existing SDKs gained delegation-rail merchant reach with no client change:

| `payTo` | Scheme | Merchant sees |
|---|---|---|
| the merchant address | **erc7710 direct settlement** (unchanged) | the delegation chain, redeemed in-band |
| the agent's own delegate EOA (+ required `merchantPayTo`) | **EIP-3009 fallback** | a standard header from the delegate EOA |

**The erc7710 `X-PAYMENT` header is x402 v2-shaped (#1064):** alongside the
scheme payload it ECHOES the accepted requirements entry (`accepted`:
scheme/network/amount/payTo/asset/maxTimeoutSeconds +
`extra.assetTransferMethod: 'erc7710'`) — @x402/core v2 merchants match the
echo field-for-field before touching the chain, and the quoted
`maxTimeoutSeconds` must round-trip (stored at authorize; pre-#1064 intents
echo the 300 default their child expiry was built with). The v1 payload-only
shape made every v2 merchant reject with a generic failure — caught by the
#1064 QA leg's first live run.

An explicit `settlementScheme` field is validated against that shape on every
rail, so a confused client fails loudly instead of silently getting the wrong
flow. Since #1360 the SDK's two 3009-shape writers (`createX402Intent`, the
local-key `authorizeX402`) ALWAYS declare `settlementScheme: 'eip3009'` —
closing the #1358-review gap where a delegate address made stale by a rotation
mid-flow was indistinguishable from a merchant `payTo` and silently routed an
open-budget agent to the erc7710 settlement branch; with the declaration it is
the loud shape-mismatch 400. Old SDKs that omit the field keep shape-only
selection (characterization-tested), and legacy-rail backends accept and
ignore the declaration. Native-token x402 is still rejected on this rail (no ERC20 transfer to
pin or meter). The chosen scheme is recorded on the intent
(`machine_metadata.settlement_scheme`, alongside `network`) so 3009-mode usage
is auditable and its eventual retirement measurable — as of #1061 the
**erc7710 branch records it too**, so the accounting feed can tell the two
schemes apart without parsing `prepared_user_op`. Since
[#1059](https://github.com/d-hinders/Haven-AI/issues/1059) the hash semantics
are honest too: `delegation_hash` records the instrument the agent **signed**
for the intent (the settlement CHILD on erc7710, the budget on the 3009
funding leg and on direct `/payments` transfers), while
**`budget_delegation_hash`** always records the METERING budget — the same
question answered uniformly, so the accounting feed's attribution reads one
column regardless of scheme (exposed per receipt in
`/machine-payments/receipts`). NULL on legacy-rail intents and on rows
predating migration 053; derived backfill was deliberately skipped.

Since #717 every relayer-paid leg (allowance transfers, sweeps, deploys)
also runs under a per-identity **relayer gas budget** (`relayer_gas_events`,
migration 054): over-cap requests get a 429 with the intent left pending —
never burned to failed — and every submitted relayer tx is recorded with its
receipt's gas numbers for cost attribution. Availability guard, not a funds
gate: it fails open on database errors because funds stay caveat-gated
on-chain either way.

Since #994 the x402 route reaches the chain only through the `ChainClient`
port and `infra/chain/` modules (binding-signer consolidated there) — the
route file itself imports no chain SDK.
Since #1130 agent authentication ahead of every x402 call distinguishes a
pending agent (`403 agent_pending_approval`, actionable) from a bad key
(`401`) — the compound misdiagnosis from #1129's URL confusion is now
separable. Since #993 the x402 authorize entry point also runs the
retired-session gate: a session-marked account gets the seam's 410 (nothing written) before
either scheme branch — it can no longer slip into the legacy AllowanceModule
flow below.

**How 3009-mode works.** EIP-3009 (`transferWithAuthorization`) is ECDSA-based —
the fund-holder must be an **EOA** that signs (USDC rejects EIP-1271 for it),
which neither Hybrid can do — so 3009-mode redeems the budget delegation to
**transiently fund the agent EOA** (a sponsored UserOp the agent signs; caveats
run on-chain at gas estimation), which then signs the standard header. One
budget delegation meters direct transfers, erc7710 settlement, and 3009 funding:
revoke once, everything stops. (The owner-side revoke signature picks its
scheme per DEVICE — a multi-signer account signs with whichever of its
signers is reachable, never forced onto the owner wallet; security model §6.)

**Pins are never weakened.** A recipient-pinned budget delegation structurally
cannot fund the EOA (the pin locks the transfer to the merchant), so
**pinned agents stay erc7710-only** — an owner decision recorded on #946, not a
limitation to engineer around. 3009-mode requires an open (unpinned) budget.

This is a deliberate, temporary interop bridge that **reintroduces a bounded
funding leg** (transient hot balance + sweep) — accepted because an agent that
can pay with a short-lived hot balance beats one that cannot pay at all;
erc7710 stays the long-term goal. The exposure is bounded by exact-amount
funding, the capped header window, the delegate-balance monitor, and the
rail-agnostic sweep (which recovers residuals to the treasury Hybrid).

(Treasury-op note, shared machinery: ops against the treasury Hybrid pin its
DEPLOYED address; for a still-counterfactual account — a zero-agent account
enrolling its first backup signer — the op instead carries initCode derived
from the full stored signer config, with the derived address checked against
the stored pin. Deploy and the signer change ride one sponsored op; no
relayer draw on that path.)

**Hardening on the authorize path** ([#961](https://github.com/d-hinders/Haven-AI/issues/961)):
an idempotent retry **resumes** — `sign_data` is reconstructed from the stored
intent rather than re-running a sponsored estimation, a confirmed retry replays
the receipt, and a stale pending row is lazily expired so its key frees;
one-shot authorize+execute is refused (a signature over not-yet-prepared state
can never be valid); and the per-agent hourly x402 cap now guards the delegation
branch too — placed after the replay lookup (replays are never rate-limited) but
before any sponsored prepare, making it sponsorship-cost protection as well.

**What a replayed `confirmed` intent means on the client**
([#1521](https://github.com/d-hinders/Haven-AI/issues/1521)). The replay above
is correct on the backend, but `status: 'confirmed'` is **ambiguous** by the
time the SDK reads it: it says the FUNDING leg confirmed, and is equally true
of a payment whose merchant leg never ran (delegate still holds the money —
resume) and one whose merchant leg completed (delegate spent — nothing left to
authorize). Only the delegate's on-chain balance separates them; Haven's own
merchant-settlement evidence cannot, because the SDK writes that record
*after* the merchant call, so a client that dies in between leaves the backend
believing the merchant was never paid.

The SDK therefore checks `balanceOf(delegate)` before minting an EIP-3009
authorization on this branch, and mints **nothing** until the branch is
decided — the authorization used to be created before the authorize call, so a
replay handed back a fresh unfundable header paired with the ORIGINAL payment's
`tx_hash`, and the caller learned what had happened only from a merchant
balance error indistinguishable from a broken rail. A verified-empty delegate
raises `X402AlreadySettledError` carrying the original receipt.

**The SDK guards two response shapes meaning "already executed"**, and a guard
written against either one alone misses the other. Only the first is produced
by a live rail:

| Shape | Produced by | Caller intent | Unverifiable balance |
|---|---|---|---|
| `success` + `tx_hash` | delegation rail's confirmed-intent replay (`modules/x402/replay.ts`) — **live** | idempotency **accident** — the caller did not ask for this payment | **refuse** |
| `next_action: retry_original_x402_request` (no `success` field) | the legacy rail's approval-queue replay — **retired**; the module that returned `getAgentPaymentStatus`'s body here (`modules/x402/legacy-authorize.ts`) was deleted by #1987, and the `executed` status behind the `next_action` is one of the four unconstructible `approval_requests` statuses #2055 removed | was the post-approval retry loop | **proceed**; only a verified-absent balance refuses |

The second row named a deleted module as a live producer until #2121. The
**SDK-side guard on that shape is retained deliberately**, fail-closed and
cheap, so the row stays on the books as a wire-compatibility record — the same
call #2100/#2101 made for the `pending_approval` branches. Read it as "if this
shape ever arrives, here is the rule", not as a flow a caller can trigger.

The explicit `resumeAuthorizedX402` path follows the second row's rule for the
same reason it was written: the caller named the payment, so refusing on
"cannot tell" would have broken every resume for an integrator without a
`chainRpcs` entry — a money-safety fix turned into an availability regression.
This is a funding-leg concern only; erc7710 has no delegate balance to exhaust.

Further hardening with #1061: a non-numeric `maxTimeoutSeconds` is a `400` at
the top of authorize rather than a `NaN` that clamps through into a `502`; and
`delegationRailBundlerUrl()` asserts that a chain-scoped bundler URL names the
chain being requested. `DELEGATION_RAIL_BUNDLER_URL` is a single value while two
chains are enabled, so a mismatched env now fails at first use with a config
error instead of quietly routing a payment at the wrong chain's bundler.

## Guardrails

- Data access for this flow lives in `packages/backend/src/infra/repositories/`
  (`x402-authorizations.ts`, `payment-intents.ts`, #995; `approval-requests.ts`
  was deleted with its table by #2055) —
  routes hold the control flow only, and every statement (idempotency lookups,
  the #961 stale-replay refresh, the settle flip) is PREPARE-checked against the
  real schema in CI via `db-schema-smoke`.
- Keep x402 budgets small and reset-bound.
- **The settling party needs native gas, and its exhaustion looks like a payment
  bug** ([#1530](https://github.com/d-hinders/Haven-AI/issues/1530)). Every
  merchant-facing settlement above — `transferWithAuthorization` on the EIP-3009
  path, `redeemDelegations` on erc7710 — is submitted by a wallet that pays gas.
  That wallet is the merchant's or facilitator's, not Haven's, and Haven cannot
  observe it. When the dev demo-merchant's settlement wallet ran to 255 gwei on
  2026-08-17, every settlement-requiring leg failed with a merchant-side error
  that named nothing about gas; the shape is indistinguishable from a broken
  payment path until someone reads the wallet. Haven's own legs were correct
  throughout. The QA harness now checks it in preflight, and the demo merchant
  reports it on `/healthz`; a third-party merchant offers no such signal, which
  is worth remembering before concluding that a settlement failure is Haven's.
- Treat the delegate key as a hot payment key for x402.
- Reconcile or sweep stranded delegate balances before scaling.
- Do not describe demo x402 endpoints as production merchant settlement,
  facilitator, acquiring, fiat/card, or merchant-of-record products.
- Use [`docs/regulatory/casp-risk-guardrails.md`](../regulatory/casp-risk-guardrails.md)
  before changing x402/MPP flows or merchant-facing demos.
