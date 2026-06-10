# Haven — Local MCP vs. Hosted MCP + Edge Signer

Deployment model decision guide for agent developers.

## The two models

| | **Local MCP** (`@haven_ai/mcp`) | **Hosted MCP + Edge Signer** (`@haven_ai/mcp-server` + `@haven_ai/signer`) |
|---|---|---|
| **Server** | Runs on the user's machine alongside the agent runtime | Haven's hosted endpoint (e.g. `https://mcp.haven.ai/v1`) |
| **Signing key** | On the local machine, loaded by the MCP process at startup | On the local machine, held exclusively by `@haven_ai/signer` |
| **Agent config** | Points to a local `npx @haven_ai/connect`-managed server | Points to the hosted URL + Bearer token; separate signer config |
| **Setup complexity** | One tool call: `npx @haven_ai/connect` | Two MCP servers: one hosted URL, one local signer binary |
| **Key exposure surface** | Loaded into the MCP process that also runs the business logic | Loaded only into the dedicated signer process; never the hosted server |
| **Runtime requirement** | Node.js on the user's machine | Internet access to Haven's endpoint; Node.js for the local signer only |
| **Multi-runtime** | One local server per agent runtime | One hosted URL shared across all runtimes; each runtime runs its own signer |

## When to use local MCP

Use `@haven_ai/mcp` when:

- You're a developer running a single agent on your own machine.
- The agent runtime and the key are co-located (e.g. Claude Desktop / Claude Code on your laptop).
- You want the simplest possible setup: one `npx @haven_ai/connect` call and you're done.
- You don't need to share a single agent identity across multiple runtimes or devices.

The `npx @haven_ai/connect` flow sets up the local MCP automatically. See
[Connect Agent 2 local-key pairing](08-connect-agent-2-local-key-pairing.md).

## When to use hosted MCP + edge signer

Use `@haven_ai/mcp-server` + `@haven_ai/signer` when:

- You want a **stable hosted URL** for the MCP endpoint (no local server to manage or update).
- You're connecting **multiple agent runtimes** to the same Haven agent identity.
- You're deploying in a **server-side environment** where running a local Node.js process per user is undesirable.
- You want the **key isolation guarantee**: the hosted server never has access to the signing key, not even transiently.

## Why the split exists (CASP/MiCA compliance)

Haven's hosted server is **non-custodial by design**. A hosted server that held the delegate private key would be a **custodial agent wallet** — which triggers CASP (Crypto Asset Service Provider) licensing requirements under MiCA in the EU.

The hosted MCP + edge signer split satisfies CASP/MiCA Red Line #2:

> The hosted server never holds, processes, or transmits the delegate private key. It constructs unsigned payment hashes and relays signed payloads. Signing authority stays at the edge with the user's local signer.

See [`docs/regulatory/casp-risk-guardrails.md`](../regulatory/casp-risk-guardrails.md) for the full guardrails.

## Tool surface parity

Both deployment models expose the same tool names wherever the semantics map cleanly:

| Tool | Local MCP | Hosted MCP |
|---|---|---|
| `haven_get_agent` | ✓ | ✓ |
| `haven_get_allowances` | ✓ | ✓ |
| `haven_get_payment_status` | ✓ | ✓ |
| `haven_get_resume_state` | ✓ | ✓ |
| `haven_list_receipts` | ✓ | ✓ |
| `haven_quote_x402` | ✓ | ✓ |
| `haven_pay_x402_quote` | Signs locally in one call | Returns `payload_hash` for edge signer |
| `haven_pay_x402` (one-shot) | ✓ (full round-trip) | — (agent orchestrates; see flow below) |
| `haven_resume_x402_payment` | ✓ | Returns signing context for edge signer |
| `haven_quote_mpp` | ✓ | ✓ |
| `haven_pay_mpp_challenge` | Signs locally | Returns `payload_hash` for edge signer |
| `haven_resume_mpp_payment` | ✓ | Returns signing context for edge signer |
| `haven_pay` (SafeTransfer) | ✓ | ✓ returns `payload_hash` |
| `haven_submit` | — | ✓ relays signature to Haven |

**Edge signer tools** (local only, paired with hosted MCP):

| Tool | Purpose |
|---|---|
| `haven_sign` | Signs a payment hash or x402 funding hash locally; returns `{ signature, x402_binding }` |
| `haven_x402_sign_header` | Builds the EIP-3009 X-PAYMENT header for the merchant leg of an x402 payment |

## x402 payment flow comparison

### Local MCP (one-shot)

```
Agent: haven_pay_x402 { url }
  ↳ MCP: probes merchant, creates funding intent, signs EIP-3009 header, retries merchant
Agent: receives merchant response
```

### Hosted MCP + Edge Signer

```
Agent → Hosted MCP:  haven_quote_x402 { url }
                     → returns { payment_required, ... }

Agent → Hosted MCP:  haven_pay_x402_quote { payment_required }
                     → returns { payment_id, payload_hash, x402.expected }

Agent → Signer:      haven_sign { payload_hash, x402_expected }
                     → returns { signature, x402_binding }
                     (key never leaves signer process)

Agent → Hosted MCP:  haven_submit { payment_id, signature }
                     → funds the delegate wallet via Safe AllowanceModule
                     → returns { status: "confirmed", tx_hash }

Agent → Signer:      haven_x402_sign_header { payment_required, x402_binding }
                     → returns { payment_header }
                     (EIP-3009 authorization signed locally)

Agent → Merchant:    GET /data   X-PAYMENT: <payment_header>
                     → receives the paid resource
```

## Custody invariant

The hosted server must **never** receive the delegate private key:

- The only data crossing from the signer side to the hosted MCP is `{ payment_id, signature }` via `haven_submit`.
- The hosted MCP boot guard (`createHostedHavenClient`) throws if a delegate key is detected on the client.
- Deep links and setup tokens from Haven may carry the hosted URL and Bearer token, but **never** the delegate key.

See [`06-hosted-mcp-connect-flow.md`](06-hosted-mcp-connect-flow.md) for the full sequence and
[`07-edge-signer.md`](07-edge-signer.md) for the signer design rationale.
