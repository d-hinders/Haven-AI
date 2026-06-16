# Haven — Edge Signer

The edge signer is the half of the hosted-MCP architecture that holds the
delegate key. The hosted server (#183) constructs and relays but cannot sign;
the edge signer signs and never lets the key leave the machine. This doc
records the **form** decision for #184 and the flows it has to support.

Contract it must satisfy: [`06-hosted-mcp-connect-flow.md`](06-hosted-mcp-connect-flow.md).
Custody guardrails: [`../regulatory/casp-risk-guardrails.md`](../regulatory/casp-risk-guardrails.md).
Connect Agent 2 local-key pairing contract:
[`../archive/connect-agent-2-local-key-pairing.md`](../archive/connect-agent-2-local-key-pairing.md).

## Decision

The edge signer ships as a new package, **`@haven_ai/signer`**, in two layers:

1. **Signer core** — framework-agnostic, no network. Loads the delegate key
   from a local secret and exposes pure operations:
   - `signPaymentHash(hash)` → raw ECDSA signature (the AllowanceModule
     funding/transfer hash). Reuses the SDK's `signHash` + `verifySignature`.
   - `signX402FundingHash(hash, expected)` → verifies Haven's signature over the
     expected context, then returns the funding signature plus a process-local
     `x402_binding` that records the funded merchant-header context returned by
     the hosted MCP.
   - `buildX402PaymentHeader(paymentRequired, x402Binding)` → the EIP-3009
     `X-PAYMENT` header for the merchant leg of an x402 payment, after
     consuming the recorded binding and checking the merchant challenge against
     it. Reuses the SDK's `selectStandardPaymentOption` +
     `toStandardPaymentRequirements` + the `x402` library.
   - Returns signatures/headers only — never the key.

2. **Local stdio MCP signer** — a thin MCP server exposing sign-only tools
   (`haven_sign`, `haven_x402_sign_header`) backed by the core. The agent
   client runs it locally **alongside** the hosted Haven connection.

SDK / autonomous agents use the **core** directly (or the existing
`HavenClient` signing). MCP-client agents (Claude Desktop / Code / Cursor) use
the **stdio front-end**. One signing core, two surfaces, key local in both.

## Why this form

| Option | Verdict |
|---|---|
| **Remote signing callback** (hosted server calls back into the user's machine to sign) | ❌ Requires inbound networking to the user's box and makes Haven orchestrate signing — re-crosses the custody line. |
| **Reuse the existing local `@haven_ai/mcp`** (full local path: key + all tools, no hosted server) | Stays valid for zero-hosted-dependency users, but it's the *whole* loop. It doesn't compose with the hosted "brain" — for hosted users you want only the key-holding piece. |
| **Signer core + local stdio MCP front-end** (this decision) | ✅ The key-only piece, reusable by both SDK and MCP-client agents. Key never leaves the local process; only signatures cross any boundary. |

This is the "host the brain, keep the signer at the edge" split from the #182
doc, realized concretely.

## Orchestration

The hosted server (brain) and the local signer (key) are two MCP servers; the
agent runtime drives the sequence.

**Regular payment**
```
hosted:  haven_pay        -> { payment_id, payload_hash }
local:   haven_sign       -> { signature }     (delegate key, never leaves)
hosted:  haven_submit     -> { status, tx_hash }
```

**x402** — two delegate signatures, both local:
```
hosted:  haven_pay_x402_quote     -> { payment_id, payload_hash, x402.expected }
local:   haven_sign + expected    -> funding signature + x402_binding
hosted:  haven_submit             -> funds Safe -> delegate EOA
local:   haven_x402_sign_header   -> EIP-3009 X-PAYMENT header if binding matches
agent:   retry merchant with X-PAYMENT, or hosted haven_complete_mcp_tool for paid MCP tools
```

## Custody invariants

- The signer process is the **only** holder of the delegate key. Nothing it
  emits contains key material — only `{ signature }` or an `X-PAYMENT` header.
- The hosted server (#183) never receives the key (it's a different process /
  host entirely). Funding relay sends only `{ payment_id, signature }` via
  `haven_submit`; paid MCP-tool completion can receive a signed, merchant-bound
  `payment_header` with the funding `payment_id` for settlement/evidence.
- The merchant gets only the standard EIP-3009 header. Haven never builds that
  header on the hosted server.
- The edge signer refuses to build the merchant header unless the caller first
  signed the funding hash with a Haven-authenticated `x402.expected`; the
  resulting binding is process-local and is consumed after one successful
  merchant header. The fresh `payment_required` must match the recorded amount,
  merchant, resource URL, asset, and network.
- Local secret handling mirrors `@haven_ai/mcp`: key from `HAVEN_DELEGATE_KEY`
  or a `--credentials` file's `delegate_key`, with a permissive-file warning.
- Connect Agent 2 may create the `--credentials` file locally during pairing.
  Haven still receives only the public signing address, proof, API-key
  hash/prefix, and install status; the hosted MCP config never receives the
  delegate key.

## Scope notes

- POC: Gnosis funding transfers + Base USDC x402, consistent with the rest of
  the architecture set.
- The signer needs no `api_key` — it only signs. Identity (the API key) lives
  with the hosted connection, not the signer.
- Hosted x402 construct requires Haven to sign the expected context with a
  dedicated `X402_BINDING_PRIVATE_KEY`. The backend deliberately does **not**
  fall back to `RELAYER_PRIVATE_KEY` — it throws if the binding key is unset, so
  the binding signer is always a separate key. The edge signer verifies it
  against `HAVEN_X402_BINDING_SIGNER` or `x402_binding_signer` in the credential
  file.
- Standard x402 briefly creates a delegate hot-wallet balance. Keep x402
  allowances small and reset-bound, retry the original merchant session after
  funding confirms, and reconcile or sweep stranded delegate balances when a
  merchant retry fails or the authorization expires unsettled.
