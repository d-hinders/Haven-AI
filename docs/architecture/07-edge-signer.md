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
  - packages/sdk/src/signer.ts
  - packages/sdk/src/sweep.ts
  - packages/sdk/src/x402.ts
  - packages/backend/src/lib/sweep.ts
  - packages/backend/src/routes/agent-connection-setups.ts
  - packages/backend/src/routes/payments.ts
  - packages/backend/src/routes/x402.ts
  - packages/backend/src/routes/machine-payments.ts
  - docs/architecture/04-x402-payment-sequence.md
  - docs/architecture/06-hosted-mcp-connect-flow.md
  - docs/regulatory/casp-risk-guardrails.md
last-verified: "2026-06-29"
---

# Haven — Edge Signer

The edge signer is the local authority half of Haven's default hosted-MCP
architecture. Hosted MCP identifies the agent, constructs unsigned payloads,
and relays externally produced signatures; `@haven_ai/signer` holds the
delegate key locally and performs sign-only operations without network access.

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
   backed by the core:
   - `haven_sign`
   - `haven_x402_sign_header`
   - `haven_sign_x402` for the one-call x402 signing fast path
   - `haven_sign_sweep_delegate` for stranded Base-USDC recovery

   The agent client runs it locally **alongside** the hosted Haven connection.
   On first launch, or when that bound configuration changes, it requires a
   consent acknowledgement tied to the delegate, optional wallet/agent/network
   metadata, and exposed tool set. Each signing operation appends a local audit
   row containing context hashes but no key, signature, or merchant header.

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
hosted:  haven_pay        -> { payment_id, payload_hash }
local:   haven_sign       -> { signature }     (delegate key, never leaves)
hosted:  haven_submit     -> { status, tx_hash }
```

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

**Decomposed x402 flow:**

```
hosted:  haven_pay_x402_quote     -> { payment_id, payload_hash, x402.expected }
local:   haven_sign + expected    -> funding signature + x402_binding
hosted:  haven_submit             -> fund Safe -> delegate EOA
local:   haven_x402_sign_header   -> EIP-3009 X-PAYMENT if binding matches
agent:   retry merchant with X-PAYMENT
```

`haven_sign_x402` creates the short-lived merchant authorization before funding
confirms, so call `haven_settle_mcp_tool` promptly. If the payment window
expires, re-run `haven_pay_mcp_tool` with the same idempotency key. Hosted x402
approval resume is not currently completable through the edge-signer tools; use
the SDK/local-MCP approval path when user approval may be required.
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
- The merchant receives the standard signed EIP-3009 payment header, never the
  delegate key. Hosted paid-MCP completion also sends the requested MCP call and
  required session/handshake traffic. Haven never builds the payment header on
  the hosted server.
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
