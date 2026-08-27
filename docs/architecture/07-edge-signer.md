---
owner: "@d-hinders"
status: current
covers:
  - packages/signer/**
  - packages/mcp-server/src/boot.ts
  - packages/mcp-server/src/auth.ts
  - packages/mcp-server/src/server.ts
  - packages/mcp-server/src/tools.ts
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
  - packages/sdk/src/signer.ts
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
last-verified: "2026-08-27" # #2082: the no-approval-path clause named the mechanism as "refuses over-budget on-chain", which stopped being accurate for the erc7710 branch — it now refuses through an off-chain remaining-budget pre-check before any chain call. The conclusion (no approval path exists on any rail) is unchanged; only the mechanism is now stated per path. Scope: that clause; nothing else re-verified. Prior: #2055: the approval-resume fallback clause corrected — no approval path exists on any rail now. Prior: #2041: the "Decomposed x402 flow" block described only the EIP-3009 bridge; it is now labelled as such and paired with the erc7710 block (`haven_sign` signs the settlement CHILD, `haven_submit { settlement_scheme: "erc7710" }` returns the header, no `haven_x402_sign_header` step). Corrected a custody-invariants claim the diff makes definitively false as a blanket statement: "Haven never builds the payment header on the hosted server" -- true on the bridge, false on erc7710, where Haven assembles the MetaMask payload server-side (`assembleSettlementPayload`, reached by `haven_settle_mcp_tool` since #1456 and by `haven_submit` since #2041). Recorded as a pre-existing gap this change widens onto a second tool, with the argument for why custody is unaffected stated rather than implied: an assembled header is a single-use, amount/merchant/nonce-bound authorization derived from a locally produced signature, not spend authority. The key-never-crosses invariant and the sweep/secret-handling sections re-read against the diff: unchanged. Prior: #1987: §"AllowanceModule-hash tools" claimed the legacy signing surface's backend code "is still present (deleted by #1987/#1988)" — #1987 has landed and it is deleted, so the claim is corrected to past tense. The signer-side tool descriptions and the delegation-rail EIP-712 path are unchanged and were re-read. Prior: #1986: the scope note "the edge-signer surface serves the legacy AllowanceModule rail" is now a statement about an unreachable surface — the backend refuses before producing a hash to sign. Corrected; the signing-scheme dispatch and key-confinement claims re-read and unchanged. Prior: #1882: front-matter only — the `last-verified` chain had DROPPED `#1309` and `#1263`. This is the #1843 shape: the note at `356e11ec` (PR #1634, #1615, 2026-08-20) DID chain, but SUMMARISED each prior entry down to a clause, and both refs lived inside the prose of the notes it compressed — `#1309` inside #1547's, `#1263` inside #1355's. The two originals are restored verbatim from `356e11ec^` at the chain tail rather than reconstructed as standalone entries, because at the moment of this drop neither ref was one. (Both HAD been standalone entries earlier — `#1309` at `a746535d` and `#1263` at `9a6198db`, 2026-08-10/11 — each replaced away in its own pre-convention drop, before this doc's window; reviewer finding, corrected here rather than left as an absolute claim.) Nothing in the body was re-verified in this pass. #1615: re-verified after internal SDK transport/state/mapping extraction; signer, authority, and hosted/local flow claims unchanged. Prior: #1547 hosted-tool prose correction; #1355 payment_id-only signing; #1352 Node floor and agent-prompt refresh Prior: #1547: the hosted tool prose stops asking agents to compare against the signer's initialize handshake (unperformable in most harnesses) — the documented default is now the structured signing-time refusal this doc already describes (#1309); the handshake surface itself is unchanged and stays advertised. Prior: #1355: the #1263 fetch also carries payment_required (persisted at authorize); haven_sign_x402 is { payment_id }-only with verbatim fallback for older backends; verification unchanged.
---

# Haven — Edge Signer

The edge signer is the local authority half of Haven's default hosted-MCP
architecture. Hosted MCP identifies the agent, constructs unsigned payloads,
and relays externally produced signatures; `@haven_ai/signer` holds the
delegate key locally and performs sign-only operations. Its only network use
is the #1263 read-only signing-context fetch (see Current Form) — it never
relays, submits, or exposes anything.

Topology and custody contract:
[`06-hosted-mcp-connect-flow.md`](06-hosted-mcp-connect-flow.md). That document
predates the one-call signer fast path; this guide and
[`04-x402-payment-sequence.md`](04-x402-payment-sequence.md) are the current
orchestration references.
Custody guardrails: [`../regulatory/casp-risk-guardrails.md`](../regulatory/casp-risk-guardrails.md).
Connect Agent 2 local-key pairing contract:
[`../archive/connect-agent-2-local-key-pairing.md`](../archive/connect-agent-2-local-key-pairing.md).

## Current Form

The edge signer ships as **`@haven_ai/signer`** in two layers:

1. **Signer core** — framework-agnostic, no network. Loads the delegate key
   from a local secret and exposes these operations:
   - `signPaymentHash(hash)` → raw ECDSA signature (the AllowanceModule
     funding/transfer hash). Reuses the SDK's `signHash` + `verifySignature`.
   - `signX402FundingHash(hash, expected)` → verifies Haven's signature over the
     expected context, then returns the funding signature plus a process-local
     `x402_binding` that records the authenticated funding-intent and
     merchant-header context returned by hosted MCP.
   - `buildX402PaymentHeader(paymentRequired, x402Binding)` → the EIP-3009
     `X-PAYMENT` header for the merchant leg of an x402 payment, after
     consuming the recorded binding and checking the merchant challenge against
     it. Reuses the SDK's `selectStandardPaymentOption` +
     `toStandardPaymentRequirements` + the `x402` library.
   - `signSweepAuthorization(authorization, expectedAuth)` → verifies Haven's
     authenticated recovery context, confirms the delegate and optional local
     Safe destination, and signs a Base-USDC EIP-3009 sweep authorization.
   - Returns signatures/headers only — never the key.

2. **Local stdio MCP signer** — a thin MCP server exposing sign-only tools
   backed by the core. Since #1263 this layer holds the signer's ONE network
   capability: an authenticated READ of a payment's exact signing context from
   Haven by `payment_id` (`GET /x402/:id/sign-context`), using the agent
   identity (`identity.json`) the connector stores next to the signer
   credential. This exists because the alternative byte source is a language
   model re-emitting multi-KB EIP-712 payloads between tool calls — runtimes
   that elide long tool results structurally cannot do that (#1255/#1263).
   Fetched bytes are untrusted input exactly like tool arguments: they pass
   the same binding verification and digest re-derivation before signing. The
   signer CORE remains network-free:
   - `haven_sign`
   - `haven_x402_sign_header`
   - `haven_sign_x402` for the one-call x402 signing fast path
   - `haven_sign_sweep_delegate` for stranded Base-USDC recovery

   The agent client runs it locally **alongside** the hosted Haven connection.
   On first launch, or when that bound configuration changes, it requires a
   consent acknowledgement tied to the delegate, optional wallet/agent/network
   metadata, and exposed tool set. Each signing operation appends a local audit
   row containing context hashes but no key, signature, or merchant header.

   **Handshake surface (#1155).** The `initialize` result also states which
   expected-context and sweep-binding versions this signer will verify —
   `capabilities.experimental["haven/signer-compatibility"]` for machines, and
   the same numbers in MCP `instructions` for the model. Both are derived from
   `SUPPORTED_X402_EXPECTED_VERSIONS` / `SUPPORTED_SWEEP_BINDING_VERSIONS` in
   `capabilities.ts`, never a second literal. It exists so version skew is
   detectable *before* a payment: the hosted quote reports the version it will
   emit, the agent compares, and a mismatch is a warning naming the fix — never
   a refusal, which stays at signing time (#1143). Only the agent sees both
   handshakes, so the comparison is agent-mediated by construction. Since
   #1547 the hosted tool prose no longer ASKS agents to run that compare —
   most agent harnesses cannot read an MCP `initialize` result, so the
   documented default is "sign; branch on the structured signing-time refusal
   below" — but the handshake stays advertised for harnesses and humans that
   can read it. The handshake carries no key material and no authority.

   **Structured signing-time refusal (#1309).** The #1143 refusal itself is
   unchanged — an unsupported expected-context or sweep-binding version still
   fails closed before any content check, and nothing is ever signed — but it
   is no longer Zod-adjacent prose an agent has to pattern-match. `haven_sign`
   / `haven_sign_x402` / `haven_sign_sweep_delegate` return
   `{ success: false, code: 'UNSUPPORTED_EXPECTED_CONTEXT_VERSION' |
   'UNSUPPORTED_SWEEP_BINDING_VERSION', supported_versions, received_version,
   fallback, next_action: 'stop_and_tell_user' }`. `supported_versions` /
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

The hosted server (brain) and the local signer (key) are two MCP servers; the
agent runtime drives the sequence.

**Regular payment**

```
hosted:  haven_pay        -> { payment_id, payload_hash, signature_scheme?, typed_data?, typed_data_b64? }
local:   haven_sign       -> { signature }     (delegate key, never leaves)
hosted:  haven_submit     -> { status, tx_hash }
```

On a **delegation-rail** account the `haven_pay` result also carries
`signature_scheme: 'eip712_userop'` and the account's EIP-712 payload in TWO
transports: `typed_data` (the object) and `typed_data_b64` (the same bytes as
one opaque base64 string, #1255). Prefer passing `typed_data_b64` to
`haven_sign` UNCHANGED — a redemption payload is multi-KB, and an agent
re-emitting the nested JSON between tool calls can truncate or reshape it,
which the signer's digest check then refuses. The Hybrid account validates
the typed data; a bare-hash signature is rejected on-chain (AA24, #1254).
Legacy-rail results omit all three fields and `haven_sign` signs
`payload_hash`. The `haven_pay_mcp_tool` / `haven_pay_x402_quote` results are
**compact by default** (#1272): they keep `signature_scheme` but omit
`typed_data`/`typed_data_b64` unless the call sets
`include_signing_payload=true`, because the preferred signing call needs
neither. When the full pair IS requested, `typed_data_b64` wins when both are
supplied — silently, so a caller that supplies both must keep them in sync: on
the direct path (no digest check) an edited `typed_data` next to a stale
`typed_data_b64` would sign the stale one.

Merchant-facing fetches on the hosted path are bounded (#1300):
`merchantTimeout` default 300 s, calibrated to the merchant's own
`maxTimeoutSeconds: 300`; a timeout AFTER confirmed funding surfaces as
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
(`haven_pay`/`haven_send`) always carry the full pair — no fetch path exists
there.

Note the trust-model asymmetry: the **x402** typed-data leg
(`signX402FundingTypedData`) verifies a Haven-authenticated expected context
and digest equality before signing; this **direct** leg does not — like the
legacy raw-hash path it always mirrored, the authority boundary is the
account's on-chain caveat enforcers (budget/recipient/expiry), not a
client-side signing gate. Do not assume `signDelegationTypedData` carries the
x402 leg's binding protection.

An over-budget result has `payload_hash: null`; stop and wait for the user to
approve and execute the Safe payment. There is nothing for the edge signer to
sign.

**Recommended paid-MCP x402 flow** — two delegate signatures in one local tool
call:

```
hosted:  haven_pay_mcp_tool     -> unsigned funding + merchant/tool context
local:   haven_sign_x402        -> funding signature + merchant-bound X-PAYMENT
hosted:  haven_settle_mcp_tool  -> relay funding, confirm, call merchant tool
```

**Decomposed x402 flow — EIP-3009 bridge:**

```
hosted:  haven_pay_x402_quote     -> { payment_id, payload_hash, x402.expected }
local:   haven_sign + expected    -> funding signature + x402_binding
hosted:  haven_submit             -> fund Safe -> delegate EOA
local:   haven_x402_sign_header   -> EIP-3009 X-PAYMENT if binding matches
agent:   retry merchant with X-PAYMENT
```

**Decomposed x402 flow — erc7710 direct settlement**
([#2041](https://github.com/d-hinders/Haven-AI/issues/2041)), taken when the
account is on the delegation rail and the merchant advertises
`extra.assetTransferMethod: "erc7710"`:

```
hosted:  haven_pay_x402_quote     -> settlement child + settlement_scheme: erc7710
local:   haven_sign { payment_id } -> child signature (caveats verified locally)
hosted:  haven_submit { settlement_scheme: "erc7710" } -> payment_header
agent:   retry merchant with X-PAYMENT
```

The signer's step is the same tool, but what it signs is not: on the bridge the
signature funds the delegate EOA, here it IS the settlement child. There is no
funding transaction and therefore no `haven_x402_sign_header` step — see the
custody note below on who assembles the header on this scheme.

`haven_sign_x402` creates the short-lived merchant authorization before funding
confirms, so call `haven_settle_mcp_tool` promptly. If the payment window
expires, re-run `haven_pay_mcp_tool` with the same idempotency key. Hosted x402
approval resume is not completable through the edge-signer tools — and since
#2055 there is no approval path on any rail to fall back to: the legacy queue
is deleted, and the delegation rail refuses over-budget instead of queueing —
on-chain (a gas-estimation revert) for direct payments and the EIP-3009 leg,
and since #2082 through an off-chain remaining-budget pre-check, before any
chain call, on erc7710.
`haven_settle_mcp_tool` confirms the funding transaction before delivering the
already signed header to the merchant.

**Gasless stranded-fund sweep (Base USDC only):**

```
hosted:  haven_sweep_delegate           -> authorization + expected_auth
local:   haven_sign_sweep_delegate      -> EIP-3009 signature
hosted:  haven_sweep_delegate + signature -> relayer submits, pays gas
```

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
  still never the key.
- The merchant receives the standard signed EIP-3009 payment header, never the
  delegate key. Hosted paid-MCP completion also sends the requested MCP call and
  required session/handshake traffic. Haven never builds the payment header on
  the hosted server **on the EIP-3009 bridge** — that blanket claim does not
  hold for erc7710, where the signed artifact is the settlement child and Haven
  assembles the MetaMask `X-PAYMENT` payload server-side from it
  (`assembleSettlementPayload`, reached by `haven_settle_mcp_tool` since #1456
  and by `haven_submit` on the generic path since
  [#2041](https://github.com/d-hinders/Haven-AI/issues/2041)). The custody
  argument is unaffected: an assembled header is a single-use,
  amount/merchant/nonce-bound authorization derived from a signature the local
  signer produced, not spend authority Haven holds.
- The edge signer refuses to build the merchant header unless the caller first
  signed the funding hash with a Haven-authenticated `x402.expected`; the
  resulting binding is process-local and is consumed after one successful
  merchant header. The fresh `payment_required` must match the authenticated
  funding-intent amount, merchant, resource URL, asset, and network.
- Local secret handling mirrors `@haven_ai/mcp`: key from `HAVEN_DELEGATE_KEY`
  or a credential file selected by `--credentials` / `HAVEN_CREDENTIALS`, with
  a permissive-file warning.
- First-launch consent must match the current signer identity and tool set.
  Acknowledgement uses `HAVEN_SIGNER_ACK` or a local
  `<credentials>.signer-ack.json` sidecar.
- MCP operations append JSONL audit entries next to the credential file or at
  `~/.haven/signer-audit.jsonl`. Entries omit keys, signatures, and headers.
- Connect Agent 2 creates local credential files during pairing. Registration
  sends Haven the setup token, runtime/version, public signing address and
  proof, API-key hash/prefix, and non-secret connector/install metadata. Later
  hosted MCP requests carry the plaintext API key as Bearer identity; it is not
  payment authority. Haven never receives the delegate private key.

## Scope Notes

- The edge-signer surface serves the **legacy AllowanceModule rail** — which
  since #1986 **no longer executes payments**. The AllowanceModule-hash tools
  described here are therefore unreachable in practice: the backend refuses
  with HTTP 410 before it ever produces a hash to sign. The surface is
  documented as-is for historical reference only: as of #1987 its backend code
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
- Regular payment/AllowanceModule-hash signing is chain-neutral; the
  backend-provided payload and on-chain wallet rules define the transfer.
- Standard merchant-verifiable x402 is exact-scheme USDC on Base and Base
  Sepolia.
- Gasless `haven_sign_sweep_delegate` recovery currently supports canonical
  USDC on Base mainnet only. It does not recover native ETH.
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
