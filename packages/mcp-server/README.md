# @haven_ai/mcp-server

Hosted, **keyless** Haven MCP server. It speaks the MCP Streamable HTTP
transport, authenticates each agent by its API key (identity), and exposes
tools that **construct** and **relay** payments. It never holds a delegate key
and has no signing path — the edge signs.

This is the counterpart to the local `@haven_ai/mcp` package. That one runs on
the agent's machine and signs locally; this one is hosted and keyless. The
split exists for one reason: a hosted server that held the delegate key would
be a custodial agent wallet. See
[`docs/architecture/06-hosted-mcp-connect-flow.md`](../../docs/architecture/06-hosted-mcp-connect-flow.md)
and [`docs/regulatory/casp-risk-guardrails.md`](../../docs/regulatory/casp-risk-guardrails.md)
(Red Line #2).

## Connect-agent role

The Haven dashboard's **Connect your agent** flow points agent runtimes at the
hosted MCP URL and sends the agent API key as a Bearer token. That token is
identity only. The delegate private key stays with the agent runtime, usually
through `@haven_ai/signer` or a runtime-local secret store.

Hosted MCP tools are deliberately split:

- read state: agent info, live allowances, payment status, transactions
- construct: return unsigned direct-payment or x402 funding hashes
- relay: submit `{ payment_id, signature }` after the edge signs

It does not expose local signing tools. Those live in `@haven_ai/signer`
(`haven_sign`, `haven_x402_sign_header`).

## Custody invariant

> Only `{ payment_id, signature }` ever crosses the wire to this server. The
> delegate private key never appears in any request, in any field.

The bound `HavenClient` is constructed without a `delegateKey`, so the signing
methods (`pay()`, `sign()`, `authorizeX402()`) are unavailable by construction.
`createHostedHavenClient` throws if a key is ever present.

## Tools

| Tool | Maps to | Signs? |
|---|---|---|
| `haven_get_agent` | `GET /machine-payments/agent` | no |
| `haven_get_allowances` | `GET /machine-payments/allowances` | no |
| `haven_pay` | `POST /payments` (returns `payload_hash`) | no — edge signs |
| `haven_submit` | `POST /payments/:id/sign` (relays signature) | no |
| `haven_x402_authorize` | `POST /x402` (returns funding `payload_hash`) | no — edge signs |
| `haven_get_payment_status` | `GET /machine-payments/:id/status` | no |
| `haven_list_transactions` | `GET /machine-payments/receipts` | no |

`haven_pay` returns `{ payment_id, payload_hash, expires_at }` in-budget, or
`{ status: "pending_approval", payload_hash: null }` when the amount exceeds the
on-chain allowance (nothing to sign; the user approves in Haven).

### x402 (keyless)

`haven_x402_authorize` takes the parsed HTTP 402 `payment_required` and returns
the **funding** step's unsigned hash plus the `x402` data (accepted option,
`resource_url`, `merchant_to`, `funding_to`, and `expected`) the edge needs. It
signs nothing — backed by the SDK's keyless `createX402Intent`. The full round trip:

1. `haven_x402_authorize` → unsigned funding `payload_hash` (+ `x402` context)
2. edge signs the funding hash with `x402.expected` → `haven_submit` (funds `Safe → delegate EOA`)
3. **edge** builds + signs the EIP-3009 `X-PAYMENT` header with the delegate key,
   but only after the current `payment_required` matches the process-local
   `x402_binding` returned by the funding signature step
4. **edge** retries the merchant with the header

Steps 3–4 are intentionally at the edge: the EIP-3009 header is a delegate-key
signature, so it can't run on the keyless hosted server, and Haven never talks
to the merchant. The header-builder lives in the edge signer (#184). Pass
`x402.expected` unchanged to the local `haven_sign` call, then pass the returned
`x402_binding` to `haven_x402_sign_header` so mismatched amount, merchant,
resource, asset, or network challenges are rejected before the delegate hot
wallet signs the merchant header. `x402.expected.auth` is signed by Haven; the
edge signer must be configured with the trusted `HAVEN_X402_BINDING_SIGNER`
address so it can reject locally invented expected contexts.

## Run

```sh
PORT=8788 HAVEN_API_URL=https://havenbackend-production-8a00.up.railway.app \
  npx @haven_ai/mcp-server
```

Endpoints: `POST /v1` (MCP, requires `Authorization: Bearer sk_agent_*`),
`GET /healthz` (liveness). The server is stateless and multi-tenant — each
request is handled by a fresh server bound to that request's token.
