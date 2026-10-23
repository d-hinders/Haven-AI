---
owner: "@d-hinders"
status: current
covers:
  - packages/signer/**
  - packages/sdk/src/userop-binding.ts
  - packages/sdk/src/direct-payment-guard.ts
  - packages/sdk/src/redemption-guard.ts
  - packages/sdk/src/delegate-account.ts
  - packages/sdk/src/settlement-child.ts
  - packages/backend/src/modules/payments/direct-sign-context.ts
  - packages/backend/src/modules/x402/eip3009-settlement-sweeper.ts
  - packages/mcp-server/src/boot.ts
  - packages/mcp-server/src/auth.ts
  - packages/mcp-server/src/server.ts
  - packages/mcp-server/src/tools.ts
  - packages/mcp-server/src/tools/state-direct-recovery.ts
  - packages/mcp-server/src/hosted-signer-integration.test.ts
  - packages/connect/src/config-writers.ts
  - packages/connect/src/api.ts
  - packages/connect/src/runtime-install.ts
  - packages/connect/src/runtime.ts
  - packages/connect/src/signer-consent.ts
  - packages/connect/src/signer-runtime.ts
  - packages/connect/src/storage.ts
  - packages/sdk/src/client.ts
  - packages/sdk/src/mcp-merchant-transport.ts
  - packages/sdk/src/merchant-egress.ts
  - packages/sdk/src/signer.ts
  - packages/sdk/src/edge.ts
  - packages/sdk/src/sweep.ts
  - packages/sdk/src/x402.ts
  - packages/backend/src/rails/sweep.ts
  - packages/backend/src/routes/agent-connection-setups.ts
  - packages/backend/src/routes/payments.ts
  - packages/backend/src/routes/x402.ts
  - packages/backend/src/routes/machine-payments.ts
  - docs/architecture/04-x402-payment-sequence.md
  - docs/architecture/06-hosted-mcp-connect-flow.md
  - docs/regulatory/casp-risk-guardrails.md
  - packages/backend/src/modules/x402/delegation-authorize.ts
  - packages/backend/src/infra/chain/delegation-budget-reader.ts
  - packages/backend/src/modules/payments/prepare-failure.ts
  - packages/backend/src/modules/x402/eip3009-settlement-evidence.ts
  - packages/mcp-server/src/tools/plain-http-x402.ts
  - packages/mcp-server/src/tools/contracts.ts
  - packages/backend/src/modules/mpp/sweep.ts
last-verified: "2026-10-19"
---

# Haven — Edge Signer

The edge signer is the local authority half of Haven's default hosted-MCP
architecture. Hosted MCP identifies the agent, constructs unsigned payloads,
and relays externally produced signatures; `@haven_ai/signer` holds the
delegate key locally and performs sign-only operations. Its only network use
is the #1263 read-only signing-context fetch (see Current Form) — it never
relays, submits, or exposes anything.

Topology, custody contract and the hosted tool chains:
[`06-hosted-mcp-connect-flow.md`](06-hosted-mcp-connect-flow.md). This guide
holds the signer; [`04-x402-payment-sequence.md`](04-x402-payment-sequence.md)
holds the x402 authority boundaries.
Custody guardrails: [`../regulatory/casp-risk-guardrails.md`](../regulatory/casp-risk-guardrails.md).
Connect Agent 2 local-key pairing contract:
[`../archive/connect-agent-2-local-key-pairing.md`](../archive/connect-agent-2-local-key-pairing.md).

## Current Form

The edge signer ships as **`@haven_ai/signer`** in two layers:

1. **Signer core** — framework-agnostic, no network. Loads the delegate key
   from a local secret and exposes these operations:
   - (removed, #3169) `signPaymentHash(hash)` — raw ECDSA over the retired
     AllowanceModule rail's hash. It was a blind-signing oracle: a digest of an
     EIP-3009 transfer out of the delegate wallet, or of a MetaMask
     `Delegation`, signed valid, and the #1476 shape-keyed refusal could not
     see a hash. `haven_sign` with a bare `payload_hash` now answers the
     structured `BARE_HASH_REFUSED` refusal (`next_action: stop_and_tell_user`,
     a typed step naming the inputs the signer CAN verify).
   - (removed, #3272) `signX402FundingHash(hash, expected)` — the
     expected-context v1 bare-hash funding path. The signer supports
     expected-context versions 2 and 3 only.
   - `signX402FundingTypedData(typedData, expected)` → verifies Haven's
     signature over the expected context and that it commits to this typed
     data's digest, then (#3281) signs only two shapes whatever the binding
     declares: a funding-leg `PackedUserOperation` that passes the
     direct-payment allowlist and pays the quoted amount to this signer's own
     delegate EOA, or an erc7710 settlement child re-delegated from this
     signer's own account (never ROOT). It then returns the funding signature
     plus a process-local
     `x402_binding` that records the authenticated funding-intent and
     merchant-header context returned by hosted MCP, plus which of the two
     shapes it signed (#4242).
   - `signDelegationTypedData(typedData)` → a verbatim primitive: signs
     whatever typed data it is handed. The allowlist that decides WHAT may be
     signed lives in the MCP tool layer (#3272, below); an embedder calling
     the core directly owns that check.
   - `buildX402PaymentHeader(paymentRequired, x402Binding)` → the EIP-3009
     merchant payment header for the merchant leg of an x402 payment, after
     consuming the recorded binding and checking the merchant challenge against
     it. Only a funding-leg binding builds a header (#4242): a binding minted
     for an erc7710 settlement child is refused, because that payment has no
     funding leg to back a delegate-EOA transfer. Since #4248 such a binding is
     retired the moment it is minted and never held, so no payment context
     outlives the call that signed the child. While its id is among the last
     64 this process retired (`RETIRED_BINDING_MEMORY`), the refusal is the
     structured `NO_FUNDING_LEG`; after that, or after a signer restart, the id
     gets the unknown-binding refusal, which also builds nothing.
     `NO_FUNDING_LEG` carries `next_action: sign_and_submit_payment`, no tool, and a
     `next_tool_omitted_reason` per site: here, submit the child signature the
     agent already holds to `haven_submit` with `settlement_scheme: 'erc7710'`;
     on `haven_sign_x402`, sign the child with `haven_sign` first. No tool is
     named because the signer's own next-step targets declare only `haven_get_payment_status`, and the refusal does not hold the signature argument a `haven_submit` step would need. Reuses the SDK's `selectStandardPaymentOption` +
     `toStandardPaymentRequirements` + the `x402` library. Since #3888 the
     authorization's nonce is not the library's random draw: the signer
     overwrites it with `deriveX402PaymentNonce(expected.paymentId)` on the
     unsigned payload `preparePaymentHeader` built, then lets the library's
     `signPaymentHeader` sign it (`packages/signer/src/core.ts:448-454`). That
     ties the merchant's on-chain `AuthorizationUsed(delegate, nonce)` to the
     Haven payment, so the backend's settlement sweeper can attribute a
     settlement the agent never reported
     (`packages/backend/src/modules/x402/eip3009-settlement-sweeper.ts:464`, the nonce the scan looks up).
     Signers older than #3888 still send a random nonce. Why this is safe is in
     the [delegation-rail security model](../security/delegation-rail-security-model.md)
     ("Since #3888 the 3009 header's nonce is derived, not random"); the
     payment sequence is in [04](04-x402-payment-sequence.md).
   - `signSweepAuthorization(authorization, expectedAuth)` → verifies Haven's
     authenticated recovery context, confirms the delegate and — when the
     local credential carries the agent's account (Haven wallet) address —
     the destination, and signs a Base-USDC EIP-3009 sweep authorization.
   - `signSiwxMessage(message)` (#3728) → EIP-191 `personal_sign` over an
     EIP-4361 message. The message always reaches it composed in-package by
     the tool layer (`siwx.ts`) from grammar-validated challenge fields, with
     the address read from this key — never a caller-supplied string, hash or
     byte payload (see Sign-In-With-X below).
   - Returns signatures/headers only — never the key.

2. **Local stdio MCP signer** — a thin MCP server exposing sign-only tools
   backed by the core. Since #1263 this layer holds the signer's ONE network
   capability: an authenticated READ of a payment's exact signing context from
   Haven by `payment_id` (`GET /x402/:id/sign-context` for an x402 intent;
   since #3271 `GET /payments/:id/sign-context` for a direct payment, fetched
   when the x402 route answers `409 sign_context_unavailable`), or by
   `task_budget_id` / `sub_budget_id` (`GET /task-budgets/:id/sign-context`,
   `GET /sub-budgets/:id/sign-context`, #3329/#3330), using the agent
   identity (`identity.json`) the connector stores next to the signer
   credential. This exists because the alternative byte source is a language
   model re-emitting multi-KB EIP-712 payloads between tool calls — runtimes
   that elide long tool results structurally cannot do that (#1255/#1263).
   Fetched bytes are untrusted input exactly like tool arguments: they pass
   the same binding verification and digest re-derivation before signing. The
   signer CORE remains network-free:
   - `haven_sign`
   - `haven_sign_siwx` for x402 Sign-In-With-X (#3728) — composes the EIP-4361
     message itself from the validated challenge, signs it EIP-191, returns the
     finished `SIGN-IN-WITH-X` header; never contacts a merchant
   - `haven_x402_sign_header`
   - `haven_sign_x402` for the one-call x402 signing fast path
   - `haven_sign_sweep_delegate` for stranded Base-USDC recovery

   The agent client runs it locally **alongside** the hosted Haven connection.
   On first launch, or when that bound configuration changes, it requires a
   consent acknowledgement tied to the delegate, optional wallet/agent/network
   metadata, and exposed tool set. Each signing operation appends, best-effort
   (since #3172 a failed audit write is reported on stderr and never fails the
   call), a local audit row containing context hashes but no key, signature,
   or merchant header.

   **Handshake surface (#1155).** The `initialize` result also states which
   expected-context and sweep-binding versions this signer will verify —
   `capabilities.experimental["haven/signer-compatibility"]` for machines, and
   the same numbers in MCP `instructions` for the model. Both are derived from
   `SUPPORTED_X402_EXPECTED_VERSIONS` / `SUPPORTED_SWEEP_BINDING_VERSIONS` in
   `capabilities.ts`, never a second literal. The same object also lists the
   direct-payment, task-budget and sub-budget sign-context versions the
   signer fetches (`direct_sign_context_versions`,
   `task_sign_context_versions`, and since #3506
   `sub_budget_sign_context_versions`, each derived from its
   `SUPPORTED_*_SIGN_CONTEXT_VERSIONS` set in `sign-context.ts`). It exists so version skew is
   detectable *before* a payment: the hosted quote reports the version it will
   emit, the agent compares, and a mismatch is a warning naming the fix — never
   a refusal, which stays at signing time (#1143). Only the agent sees both
   handshakes, so the comparison is agent-mediated by construction. Since
   #1547 the hosted tool prose no longer ASKS agents to run that compare —
   most agent harnesses cannot read an MCP `initialize` result, so the
   documented default is "sign; branch on the structured signing-time refusal
   below" — but the handshake stays advertised for harnesses and humans that
   can read it. The handshake carries no key material and no authority.
   Since #3738 the `instructions` also state the agent id and delegate
   address the signer is bound to, so a model holding several Haven pairs can
   check them against `haven_get_agent`'s `id` / `delegateAddress`; advisory,
   and neither value is secret.

   **Structured signing-time refusal (#1309).** The #1143 refusal itself is
   unchanged — an unsupported expected-context or sweep-binding version still
   fails closed before any content check, and nothing is ever signed — but it
   is no longer Zod-adjacent prose an agent has to pattern-match. `haven_sign`
   / `haven_sign_x402` / `haven_sign_sweep_delegate` return
   `{ success: false, code: 'UNSUPPORTED_EXPECTED_CONTEXT_VERSION' |
   'UNSUPPORTED_SWEEP_BINDING_VERSION', supported_versions, received_version,
   fallback, next_action: 'stop_and_tell_user', next_tool_omitted_reason }`
   (the last field since #3103 — no tool can fix a version skew from inside
   the call). `supported_versions` /
   `received_version` are DERIVED at the throw site from
   `SUPPORTED_X402_EXPECTED_VERSIONS` / `SUPPORTED_SWEEP_BINDING_VERSIONS`,
   never a second literal (`assertSupportedBindingVersion` in `core.ts`).
   `fallback` is the SAME string (`SIGNER_UPDATE_FALLBACK`, `@haven_ai/sdk`)
   the hosted quote's advisory `signer_compatibility.fallback` carries, so an
   agent that meets either surface gets identical recovery guidance. This
   narrows *how* the refusal is reported, not what is enforced — see
   `docs/operations/mcp-runtime-compatibility.md` for the diagnosability gap
   it closes and the full skew table. `signerInstructions()` (`capabilities.ts`)
   now states this in prose too, alongside the version-set lines, so an agent
   that only ever reads MCP `instructions` still learns the refusal carries
   `code` / `supported_versions` / `received_version` / `fallback` as data,
   not just a message to pattern-match.

   **MCP `instructions` on the two payment-brain servers (agent-prompt audit,
   items A/B).** Since #1306–#1311 shipped the guided catalog-purchase flow
   (`haven_prepare_catalog_purchase`), the structured next-step contract
   (`next_action`/`next_tool`/`next_arguments`), and payment_id-only signing
   and settling, both `buildHostedMcpServer` (`packages/mcp-server/src/server.ts`)
   and `buildMcpServer` (`packages/mcp/src/server.ts`) also set MCP
   `instructions` — a compact, version-literal-free critical path (identity
   first, catalog purchase with a spending cap (`max_amount_human`), follow the response's guidance
   fields, sign/settle by `payment_id`, a decline or an unrecognised status
   means stop) for
   clients that surface `instructions` even when they never render individual
   tool descriptions. The local server's instructions omit the signer
   namespace and `payment_id` signing step entirely — that runtime signs
   in-process with the delegate key it holds, so there is nothing there to
   describe. Neither server's `instructions` are part of the local MCP or
   signer consent hash (`packages/mcp/src/consent.ts`,
   `packages/signer/src/consent.ts` hash identity + tool NAMES + allowance
   summary / a surface version, never description or instruction text), so
   this addition does not re-trigger consent.

SDK / autonomous agents use the **core** directly (or the existing
`HavenClient` signing). MCP-capable runtimes use the **stdio front-end**. One
signing core, two surfaces, key local in both.

## Why this form

| Option | Verdict |
|---|---|
| **Remote signing callback** (hosted server calls back into the user's machine to sign) | ❌ Requires inbound networking to the user's box and makes Haven orchestrate signing — re-crosses the custody line. |
| **Reuse the existing local `@haven_ai/mcp`** (full local path: key + all tools, no hosted server) | Stays valid for zero-hosted-dependency users, but it's the *whole* loop. It doesn't compose with the hosted "brain" — for hosted users you want only the key-holding piece. |
| **Signer core + local stdio MCP front-end** (this decision) | ✅ The key-only piece, reusable by both SDK and MCP-client agents. Key never leaves the local process; only signatures or signed merchant headers cross a boundary. |

This realizes the "host the brain, keep the signer at the edge" split without
giving the hosted service payment-signing authority.

## Orchestration

> **Re-verified #3495 (2026-09-30):** the "Regular payment" sequence, the
> paragraphs through the compact-by-default note below, and the "Preferred
> x402 form" paragraph's direct-payment sentence further down (which used to
> say direct payments "always carry the full pair as well, for older
> signers" — no longer true since #3495) were updated for the #3495 owner
> decision (direct-payment results compact by default, relay behind an
> `include_signing_payload: true` opt-in) and its review-round-1 and
> round-2 corrections (the two-trigger-shape fix, the S5 no-sign-data-replay
> guard, the direct fetch's 404 naming both routes). Nothing else in this
> document was re-verified in this pass.

The hosted server (brain) and the local signer (key) are two MCP servers; the
agent runtime drives the sequence.

**Regular payment**

```
hosted:  haven_pay        -> { payment_id, status, idempotency_key, payload_hash, next_tool: haven_sign, next_arguments: { payment_id }, signature_scheme?, signer_compatibility }
local:   haven_sign { payment_id } -> { signature }   (delegate key never leaves)
         (or, on a refusal carrying fallback: 'typed_data_b64' — ANY code —
          or SIGN_CONTEXT_REFUSED / sign_context_unavailable from a signer
          predating #3271, re-run haven_pay with the SAME idempotency_key
          plus include_signing_payload: true, then haven_sign
          { payload_hash, typed_data_b64 } from THAT result — the recovery
          route the result's signer_compatibility notice names)
hosted:  haven_submit     -> { status, tx_hash }
```

On a **delegation-rail** account the `haven_pay` result also carries
`signature_scheme: 'eip712_userop'`. **Since #3271 a current signer accepts
`haven_sign({ payment_id })` for a direct payment**: it fetches the exact bytes
itself (`GET /payments/:id/sign-context`), so nothing bulky crosses the agent's
context. That fetch exists because the relay failed live: on 2026-09-24 a
hand-relayed `typed_data_b64` arrived altered, the signer signed it without
complaint, and the bundler rejected the operation (`AA24 signature error`).
**Since #3277 the hosted result names that call** — `next_tool: haven_sign`,
`next_arguments: { payment_id }` (the exact `SIGNER_HANDOFF_SHAPES` shape),
with a `signer_compatibility` notice alongside. Per the #1547 pattern the
notice never asks the agent to compare a version against `initialize`
instructions: on a failure the signer can produce — TWO distinct shapes,
covered separately below (review round 1 caught an earlier draft that
conflated them into one wrong trigger) — it has signed nothing.

**Since #3495 (owner decision 2026-09-30, superseding #3277 AC2 "the relay
fields stay") `haven_send` / `haven_pay` results are compact by default**,
mirroring the x402 quote tools' own #1272 contract exactly: no `typed_data` /
`typed_data_b64` inline, only `signature_scheme` (when the rail is
delegation). The caller's `idempotency_key` is generated fresh (never
derived from the payment's own parameters — two separate sends of the same
amount to the same recipient are routinely different payments) when omitted,
and always echoed on the result. The notice's recovery route is a re-run of
the SAME tool with the SAME `idempotency_key` plus `include_signing_payload:
true` — the backend replays the stored payment on that key
(`findPaymentReplay`, `payments.ts`) rather than minting a second intent,
provided the re-run repeats the original token/amount/recipient/
task_budget_id/sub_budget_id (a mismatch answers 409). That re-run's own
result then carries `payload_hash` + `typed_data_b64`, passed through
unchanged to `haven_sign` — its OWN reason says so directly, rather than
looping the agent back through `payment_id` again. The route covers two
DISTINCT refusal shapes: (1) any refusal carrying `fallback: 'typed_data_b64'`,
whatever its code — a currently-published `@haven_ai/signer` sets that field
only on a transport failure, a malformed body, or a 404 on an older backend;
(2) `SIGN_CONTEXT_REFUSED` with `backend_error_code: 'sign_context_unavailable'`
and NO `fallback` field, which only a signer predating #3271 produces (it has
no direct-fetch fallback of its own to try). On either path a current signer now runs the UserOp binding check before signing
(`assertUserOpTypedDataBinding`, `@haven_ai/sdk`): it recomputes the v0.7
UserOperation hash from the typed data and refuses (`USEROP_BINDING_MISMATCH`)
unless it equals `payload_hash`, and pins the domain, field list and
EntryPoint the hash does not cover. The Hybrid account validates the typed
data; a bare-hash signature is rejected on-chain (AA24, #1254).
Legacy-rail results omit `signature_scheme`, `typed_data` and `typed_data_b64`
alike, and since #3169 `haven_sign` REFUSES such a call (`BARE_HASH_REFUSED`)
rather than signing `payload_hash`.
`haven_pay_mcp_tool` / `haven_pay_x402_quote` / `haven_send` / `haven_pay` are
all **compact by default** (#1272, extended to the direct-payment pair by
#3495): every one keeps `signature_scheme` but omits `typed_data`/
`typed_data_b64` unless the same-key re-run sets `include_signing_payload:
true`, because the preferred signing call needs neither. When the full pair
IS requested, `typed_data_b64` wins when both are supplied — silently, so a
caller that supplies both must keep them in sync: on a direct payment an
edited `typed_data` next to a stale `typed_data_b64` signs the stale one only
if the stale one still matches `payload_hash` (the #3271 binding check
refuses otherwise).

Merchant-facing fetches on the hosted path are bounded (#1300):
`merchantTimeout` default 300 s, calibrated to the merchant's own
`maxTimeoutSeconds: 300`. Since #3747 the hosted client also installs
`strictMerchantEgressPolicy()` (`packages/sdk/src/merchant-egress.ts`):
public https URLs only — a string check on the URL; a public name whose DNS
answer points at private space is not blocked (#3742–#3744) — per-use byte
caps, and per-use deadlines of 15 s for quote probes and MCP session setup,
5 s for discovery and 300 s for paid delivery. In the SDK merchant transport
every GET redirect hop is re-checked (at most 3, none on other methods) and
each deadline is the minimum of the policy value and `merchantTimeout`;
discovery and the #3739 request-mode probe use the policy deadline directly
and follow no redirect (`redirect: 'error'`); a timeout AFTER confirmed funding surfaces as
`MERCHANT_UNRESPONSIVE_AFTER_FUNDING` with verify-then-sweep guidance —
never a blind sweep, since the merchant may still settle late.

The one-call tool also accepts a BASE merchant URL (#1271): hosted MCP
resolves the real MCP endpoint through the merchant's same-origin discovery
document (bounded, no redirects, off-origin refused) and returns the RESOLVED
`merchant_url` — the agent passes that to settle/complete. Discovery carries
no payment authority; the signer's verification is unaffected.

**Preferred x402 form (#1263, #1355):** pass `payment_id` alone — the signer
fetches `payload_hash`, `typed_data`, the complete expected context, AND (since
#1355) the merchant's 402 `payment_required` from Haven itself, so nothing
bulky ever crosses the agent's context. On a pre-#1355 backend whose
sign-context carries no `payment_required`, the one-call tool asks the agent to
re-call with it added verbatim; whichever copy is used passes the same
expected-context verification. For older signers and diagnostics,
re-run the quote tool with the SAME `idempotency_key` plus
`include_signing_payload=true`: the replay returns the ORIGINAL sign_data
(#1207 semantics), and `typed_data_b64` / `typed_data` remain the fallback
transport for older backends and for the fully offline core. Direct payments
(`haven_pay`/`haven_send`) have a fetch path since #3271
(`GET /payments/:id/sign-context`); since #3495 they are compact by default
too, and the same-key `include_signing_payload: true` re-run described above
is how the pair is restored for older signers and diagnostics.

Note the trust-model asymmetry: the **x402** typed-data leg
(`signX402FundingTypedData`) verifies a Haven-authenticated expected context
and digest equality before signing, and since #3281 also refuses any shape
but a guarded funding leg or a verified settlement child, so a compromised
binding key cannot widen what it signs (epic #3284's threat model). The **direct** leg's binding check (#3271)
is a CORRUPTION check, not an authentication: the caller supplies both the
typed data and `payload_hash`, so the check proves they describe the same
operation, never that Haven prepared it. The authority boundary remains the
account's on-chain caveat enforcers (budget/recipient/expiry). What the unbound
branch will sign at all is narrowed by #3272: `haven_sign` signs typed data
without an x402 context only when it is a `PackedUserOperation` for this
signer's own derived delegate account, on a chain with pinned delegation
contracts, whose `callData` is a single `execute` to the DelegationManager
calling `redeemDelegations` with one of three chain shapes: a single
grant made TO this account by a different account, a two-link
`[task child, budget]` chain whose leaf is self-delegated by this account
(#3329), or a three-link `[sub grant, parent child, budget]` chain (#3330)
whose leaf is granted TO this account by the delegating agent's account,
whose middle link is that agent's self-narrowing, and whose root is that
agent's budget grant from elsewhere — in
`SingleDefault` mode, canonically encoded — an
empty chain would make the DelegationManager execute as the account itself.
Anything else is refused with
`TYPED_DATA_NOT_ALLOWED`. The core's `signDelegationTypedData` itself signs
verbatim; the allowlist is in the tool layer. Since #3283 that allowlist, the
redemption guard, the account derivation and the settlement-child verifier
are one implementation in `@haven_ai/sdk` (imported here from
`@haven_ai/sdk/edge`), which the SDK's own `HavenClient.signForData` runs too.

The edge entry also hosts the x402 buyer tax-declaration builder (#3427,
`tax-declaration.ts`): the delegate key signs the wg-tax #5 §2.1 declaration
content — typed data assembled locally, refusing any `principalId`/
`principalAttributionHash`/unknown field that arrives pre-set — and the
signature rides the paid EIP-3009 merchant retry to the seller only as
`X-Tax-Declaration`. It is an attestation, not an authority: nothing is
redeemed, spent or unlocked by it, so it sits beside the guards rather than in
their allowlist.

**An over-budget direct payment is DECLINED, not queued** (#2130). The old text
here said the result carries `payload_hash: null` and told the agent to "wait
for the user to approve and execute the Safe payment" — an approval that cannot
arrive on any rail, and which this file already contradicts two sections below.
What actually happens on `POST /payments`: an agent with no active budget
delegation for that token/recipient (a recipient outside a pin, or a grant
outside its validity window) gets a **403**; a period-budget pre-check refuses
an amount the remaining budget cannot cover with a typed **403
`delegation_budget_exceeded`** (#3503); anything out of policy that still
reaches `prepareDelegationPayment`'s gas estimation (a budget the pre-check
could not read, for one) is rejected by the caveat enforcer there. A revert a
fresh read confirms is the period budget's (#3503) or an open task budget's
cap (#3500) answers the same typed 403 as that budget's pre-check
(`delegation_budget_exceeded` / `task_budget_exceeded`); a chain with no
bundler credential on this deployment is a typed, non-retryable **503**
(#3416); anything else is a **502 with no payment row written**, typed since
#3609 as `prepare_reverted` (an execution revert) or `prepare_failed`, both
with bounded `details` (`routes/payments.ts`,
`modules/payments/prepare-failure.ts`).
In every case there is no intent row, no `payload_hash` to sign, and
nothing to poll — tell the user to raise the budget in Haven.

**Recommended paid-MCP x402 flow** — two delegate signatures in one local tool
call:

```
hosted:  haven_pay_mcp_tool     -> unsigned funding + merchant/tool context
local:   haven_sign_x402        -> funding signature + merchant-bound payment header
hosted:  haven_settle_mcp_tool  -> relay funding, confirm, call merchant tool
```

**Decomposed x402 flow — EIP-3009 bridge:**

```
hosted:  haven_quote_x402         -> price + next_arguments { url, method, headers, body, max_amount_human }
hosted:  haven_pay_x402_quote     -> { payment_id, payload_hash, x402.expected }
local:   haven_sign + expected    -> funding signature + x402_binding
hosted:  haven_submit             -> fund delegated agent EOA from the account budget
local:   haven_x402_sign_header   -> EIP-3009 payment header if binding matches
agent:   retry merchant, setting BOTH PAYMENT-SIGNATURE + X-PAYMENT
hosted:  haven_report_x402_outcome { payment_id, outcome, merchant_status, payment_header }
```

Since #3739 (PR #3762) the pay step takes the quoted request (`url`, `method`,
`headers`, `body`) and re-sends it itself, paying the 402 it got, so the agent
never copies a challenge. The hosted guidance names the one-call local form,
`haven_sign_x402` in place of the two local steps (its header is built before
funding confirms; the `x402_binding` it returns is already spent). The header
tools return `retry_headers`, the header names to set (#3727). The outcome
report may fold in the settlement evidence. On this EIP-3009 path only (erc7710
needs no header: Haven assembled it), since #3925 a reported settlement is
recorded only when the report carries the `payment_header` the agent retried
with; since #4061 a report without it is refused as
`SETTLEMENT_PROOF_HEADER_MISSING`, and both report tools forward the header.

**Decomposed x402 flow — erc7710 direct settlement**
([#2041](https://github.com/d-hinders/Haven-AI/issues/2041)), taken when the
account is on the delegation rail and the merchant advertises
`extra.assetTransferMethod: "erc7710"`:

```
hosted:  haven_pay_x402_quote     -> settlement child + settlement_scheme: erc7710
local:   haven_sign { payment_id } -> child signature (caveats verified locally)
hosted:  haven_submit { settlement_scheme: "erc7710" } -> payment_header
agent:   retry merchant, setting PAYMENT-SIGNATURE ONLY (#2341 — this header
         carries the delegation chain; duplicating it is refused with 431)
hosted:  haven_report_settlement_evidence { payment_id, settlement_tx_hash }
```

The signer's step is the same tool, but what it signs is not: on the bridge the
signature funds the delegate EOA, here it IS the settlement child. There is no
funding transaction and therefore no `haven_x402_sign_header` step — see the
custody note below on who assembles the header on this scheme. Since #4242 the
signer enforces this rather than leaving it to guidance: `haven_x402_sign_header`
never builds a header from a settlement-child binding (it answers
`NO_FUNDING_LEG` while the retired id is still remembered, the unknown-binding
refusal after that), and `haven_sign_x402` refuses a settlement child before
signing it. Only a funding-leg binding builds a header.

`haven_sign_x402` creates the short-lived merchant authorization before funding
confirms, so call `haven_settle_mcp_tool` promptly. If the payment window
expires, re-run `haven_pay_mcp_tool` with the same idempotency key. Hosted x402
approval resume is not completable through the edge-signer tools — and since
#2055 there is no approval path on any rail to fall back to: the legacy queue
is deleted, and the delegation rail refuses over-budget instead of queueing.
On a healthy budget read every path refuses at a remaining-budget pre-check —
erc7710 since #2082, the EIP-3009 funding leg since #2706, `POST /payments`
since #3503 — and on direct payments and the 3009 leg the enforcer's
gas-estimation revert is what a failed-open pre-check reaches. The pre-check is itself an
`eth_call` against the enforcer's storage, so what it precedes is the
REDEMPTION, not every chain call.

Both pre-checks fail open on a degraded read, and there the two schemes part
company: the 3009 leg falls through to prepare, where the enforcer refuses and
authorize answers `502`; the erc7710 branch prepares nothing, so it hands back
`201 pending_signature` WITH `sign_data` — the #1993 shape #2082 closed,
reappearing exactly when the read degrades. On erc7710 a degraded read is the
alarming outcome, not a reassuring one.
`haven_settle_mcp_tool` confirms the funding transaction before delivering the
already signed header to the merchant.

**Gasless stranded-fund sweep (Base USDC only):**

```
hosted:  haven_sweep_delegate           -> authorization + expected_auth
local:   haven_sign_sweep_delegate      -> EIP-3009 signature
hosted:  haven_sweep_delegate + signature -> relayer submits, pays gas
```

**Sign-In-With-X (x402 extension, #3728) — the delegate EOA signs in as the
wallet that paid; no facilitator and no Haven involvement:**

```
merchant: 402 with extensions['sign-in-with-x'] -> challenge
local:    haven_sign_siwx { url, challenge } -> SIGN-IN-WITH-X header
agent:    retry the merchant with the SIGN-IN-WITH-X header set to that value
```

The signer composes the EIP-4361 message itself from grammar-validated
challenge fields (domain == URL host, resource uri origin == URL origin,
https URL, alphanumeric nonce ≥ 8 chars, expiry window ≤ 5 minutes plus a
pinned 30-second clock-skew tolerance,
`supportedChains` offering the credential chain with `eip191`) and the
delegate address read from the key — it never signs a caller-supplied
message, hash or byte string, so a SIWX signature cannot double as a payment
authorization or any other Haven signature. Phase 1 is the delegate EOA only
(EIP-1271/6492 for the delegate account is phase 2); the user's treasury
account is permanently out of scope.

## Custody invariants

- The delegate key remains in user-controlled local storage or runtime memory.
  The edge-signer process reads it for this path; Haven's hosted services never
  receive it. Nothing the signer emits contains key material.
- The hosted server never receives the key. Funding relay sends only
  `{ payment_id, signature }` via
  `haven_submit`; paid MCP-tool completion can receive a signed, merchant-bound
  `payment_header` with the funding `payment_id` for settlement/evidence.
  On the **erc7710** scheme the relayed artifact is not a funding signature at
  all — it is the settlement child — and the header travels the other way, from
  Haven back to the agent. Still only a signature crosses the boundary, and
  still never the key. On the plain-HTTP path the agent's settlement report
  (`haven_report_x402_outcome` / `haven_report_settlement_evidence`) carries
  the `payment_header` it retried with, after the merchant has used it: since
  #3925 an agent-reported EIP-3009 settlement is recorded only with that
  header, and only when the payment's delegate signed it. Since #4061 both
  report tools forward it, and a header lifted from another payment of the
  same agent is refused: its nonce is that payment's derived nonce.
  The #3888 sweep records without one, from the nonce derived from the
  payment id.
- The merchant receives the standard signed EIP-3009 payment header, never the
  delegate key. Hosted paid-MCP completion also sends the requested MCP call and
  required session/handshake traffic. Haven never builds the payment header on
  the hosted server **on the EIP-3009 bridge** — that blanket claim does not
  hold for erc7710, where the signed artifact is the settlement child and Haven
  assembles the MetaMask payment payload server-side from it
  (`assembleSettlementPayload`, reached by `haven_settle_mcp_tool` since #1456
  and by `haven_submit` on the generic path since
  [#2041](https://github.com/d-hinders/Haven-AI/issues/2041)). The custody
  argument is unaffected: an assembled header is a single-use,
  amount/merchant/nonce-bound authorization derived from a signature the local
  signer produced, not spend authority Haven holds.
- The edge signer refuses to build the merchant header unless the caller first
  signed the funding hash with a Haven-authenticated `x402.expected`; the
  resulting binding is process-local and is consumed after one successful
  merchant header. Only a funding-leg binding qualifies (#4242). The fresh `payment_required` must match the authenticated
  funding-intent amount, merchant, resource URL, asset, and network.
- Startup (#3173): the signer imports `@haven_ai/sdk/edge`, never the SDK
  barrel, and loads `x402/schemes` only on the merchant-header leg, so no
  `ethers` or `x402` module resolves at startup (roughly halved: `--help`
  1.47 s → 0.71 s, consent refusal 1.55 s → 0.77 s, medians of 5 cold runs on
  macOS / Node 22 — conditions and the import-timing split in
  `packages/signer/README.md`). Unknown CLI options are refused
  (exit 2, naming `--help`); `--help` lists every registered tool; the consent
  block summarises each tool in one line and, like the no-consent exit message,
  names `npx @haven_ai/connect --doctor` for the connector-wired case.
- Local secret handling mirrors `@haven_ai/mcp`: key from `HAVEN_DELEGATE_KEY`
  or a credential file selected by `--credentials` / `HAVEN_CREDENTIALS`, with
  a permissive-file warning.
- First-launch consent must match the current signer identity and tool set.
  Acknowledgement uses `HAVEN_SIGNER_ACK` or a local
  `<credentials>.signer-ack.json` sidecar. Re-acknowledgement after a tool-set
  change needs no setup token (#3799): run the recorded wrapper with `--ack`
  and stdin closed (`<dir>/bin/haven-signer.mjs --ack < /dev/null`), or
  `npx @haven_ai/connect --doctor --repair --ack-local-tools` — the ack is
  written by the installed signer, so an override cannot mint a mismatching
  hash.
- MCP operations append JSONL audit entries next to the credential file or at
  `~/.haven/signer-audit.jsonl`. Entries omit keys, signatures, and headers.
  Since #3172 the sidecar is created owner-only (`0600`), a permissive one is
  tightened in place on the next append (before rotation; a symlink is warned
  about, never chmod-ed through), the file rotates to `<path>.1` at 8 MiB (one
  predecessor kept), a failed audit write never fails the signing call that
  already produced its signature, and `payload_hash` / `typed_data_hash` are
  bounded on the schema to a 32-byte hash so no audit field is
  caller-controlled free text. A `haven_sign_siwx` row (#3728) records the
  sha256 of the JSON-encoded composed EIP-4361 message (`hashPayloadForAudit`)
  as its `payload_hash`, plus the
  challenge's grammar-validated `domain` and `nonce`; never the message
  itself.
- Connect Agent 2 creates local credential files during pairing. Registration
  sends Haven the setup token, runtime/version, public signing address and
  proof, API-key hash/prefix, and non-secret connector/install metadata. Later
  hosted MCP requests carry the plaintext API key as Bearer identity; it is not
  payment authority. Haven never receives the delegate private key.

## Scope Notes

- The edge-signer surface ONCE served the **legacy AllowanceModule rail** —
  which since #1986 **no longer executes payments** (the backend answers HTTP
  410 before it ever produces a hash to sign). The AllowanceModule-hash signing
  surface is GONE, not merely unreachable: #3169 removed `signPaymentHash` and
  `haven_sign` refuses a bare hash. The rail's history is kept here for
  reference only: as of #1987 its backend code
  is **deleted**, not merely refused — there is no `generateTransferHash` and
  no `executeAllowanceTransfer` left to reach. Nothing here is a path a caller
  can complete, and nothing here is a path that still exists server-side.
  Delegation-rail payments (#829/#830) sign the account's EIP-712 typed data
  verbatim via the SDK — `HavenClient` dispatches on
  `sign_data.signature_scheme` (`eip712_userop` for payments,
  `eip712_delegation` for x402 settlement) to
  `signUserOpTypedDataForDelegation` — and are not exposed as edge-signer or
  hosted-MCP tools today. The retired session rail's `eip191_userop` scheme is
  refused (#834).
- Regular payment signing is chain-neutral; the backend-provided payload and
  on-chain wallet rules define the transfer (AllowanceModule-hash signing:
  removed, #3169).
- Standard merchant-verifiable x402 is exact-scheme USDC on Base and Base
  Sepolia.
- Gasless `haven_sign_sweep_delegate` recovery supports canonical Circle USDC
  on Base mainnet and on Base Sepolia (dev/QA): the chains `isSweepableChain`
  in `packages/sdk/src/sweep.ts` knows, which the backend's sweep prepare
  gates on. It does not recover native ETH.
- The signer needs no `api_key` — it only signs. Identity (the API key) lives
  with the hosted connection, not the signer.
- Hosted x402 construct requires Haven to sign the expected context with a
  dedicated `X402_BINDING_PRIVATE_KEY`. The backend deliberately does **not**
  fall back to `RELAYER_PRIVATE_KEY` — it throws if the binding key is unset, so
  the binding signer is always a separate key. The edge signer verifies it
  against `HAVEN_X402_BINDING_SIGNER` or `x402_binding_signer` in the credential
  file.
- Standard x402 can create or leave an agent-wallet balance. Keep x402
  allowances and agent-wallet balances small, retry the original merchant
  session after funding confirms, and reconcile or sweep stranded delegate
  balances when a merchant retry fails or the authorization expires unsettled.

> **Re-verification (#3935, the derived EIP-3009 nonce, 2026-10-14):** the
> `buildX402PaymentHeader` sentences were added against `origin/dev`
> `686ac03c` (`packages/signer/src/core.ts`, the backend's
> `eip3009-settlement-sweeper.ts`). Scope of this note: that bullet. The rest
> of this document was not re-read for it, and `last-verified` is not bumped.

> **Re-verified 2026-10-19 (weekly docs audit #3645, at dev `cf88627c`):** the
> whole document was re-read against the code. Changed: the core lists
> `signSiwxMessage` (#3728); the handshake paragraph names the sign-context
> version sets (#3506 added the sub-budget one); the #3272 allowlist accepts
> the #3330 three-link sub-budget chain, not two shapes; the over-budget 502 is
> typed (#3609) and a confirmed budget revert answers 403; the hosted egress
> policy's deadlines and caps (#3747); the decomposed x402 flows gain the quote
> step (#3739) and the outcome / settlement-evidence report, with the proof
> header #3925 requires; the SIWX audit row; and the sweep supports Base
> Sepolia as well as Base mainnet (`isSweepableChain`). Checked and accurate:
> the `core.ts:448-454` and sweeper `:464` line anchors, the tool set and
> `--help` / unknown-option exit 2 (run), the consent and ack paths, the audit
> rotation constants, the SIWX grammar limits, and the 300 s delivery default.
