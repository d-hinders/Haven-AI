---
owner: "@d-hinders"
status: current
covers:
  - packages/mcp-server/src/**
  - packages/connect/**
  - packages/signer/**
  - packages/frontend/src/components/ConnectAgent2Modal.tsx
  - packages/frontend/src/lib/hosted-connect.ts
  - packages/backend/src/routes/agent-connection-setups.ts
  - packages/backend/src/routes/payments.ts
  - packages/backend/src/routes/x402.ts
  - packages/backend/src/lib/payment-coverage.ts
  - packages/backend/src/lib/sweep.ts
  - packages/sdk/src/client.ts
  - packages/sdk/src/x402.ts
last-verified: "2026-07-01"
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
| Safe AllowanceModule | On-chain allowance | Automatic-spend enforcement |

API authentication is identity, a delegate signature is authority, and the
on-chain module is enforcement. Hosted MCP must never accept, store, or log a
delegate key. It has a boot-time guard that rejects an injected key.

For direct funding relay, the agent sends only the locally produced
`{ payment_id, signature }` to hosted MCP. Paid MCP completion may additionally
send a signed, merchant-bound `payment_header`; that single-use authorization
is not a key.

## Current connection flow

Staged Connect Agent pairing is the only current dashboard flow:

1. The user chooses the Haven wallet, agent rules, and agent budget.
2. Haven creates a pending setup and returns a setup token and connector
   command.
3. The connector runs locally, generates the delegate signing key and API key,
   and stores both in protected local runtime configuration.
4. Registration sends only the setup token, runtime/version metadata, public
   signing address and proof, and API-key hash/prefix. No private key or
   plaintext API key is registered.
5. The user signs the wallet approval. The agent cannot spend until the
   AllowanceModule permission exists on-chain.
6. Later hosted requests use the locally stored API key as Bearer identity;
   the local signer retains the delegate key as authority.

Manual fallback is limited to the explicit, warning-gated surfaces that support
it. Setup links and snippets may contain hosted identity configuration, but
never a delegate key.

## Direct payment

1. `haven_pay` asks the backend to construct a payment intent.
2. Within the remaining allowance, it returns `payment_id`, `payload_hash`, and
   expiry. Above the remaining allowance it queues for user approval and
   returns no signable hash.
3. `haven_sign` signs the hash locally.
4. `haven_submit` relays the signature; the backend verifies the delegate and
   executes the AllowanceModule transfer.

## x402

The recommended paid-MCP path is:

```text
haven_pay_mcp_tool
  → haven_sign_x402
  → haven_settle_mcp_tool
```

Hosted MCP prepares the funding and merchant contexts, the signer locally
authorizes both legs, and hosted MCP relays the signed merchant authorization.

The generic decomposed path remains available:

```text
haven_quote_x402 / haven_pay_x402_quote
  → haven_sign
  → haven_submit
  → haven_x402_sign_header
  → merchant retry or haven_complete_mcp_tool
```

For balance-aware x402 coverage:

- `amount <= remaining allowance` can execute;
- `remaining < amount <= remaining + delegate balance` queues for approval;
- `amount > remaining + delegate balance` is rejected as insufficient coverage.

Neither a queued nor rejected request returns a funding hash.

## Tool surfaces

Hosted MCP provides identity and allowance reads, direct send/prepare/submit,
x402 and MPP quote/resume/status operations, paid-MCP prepare/settle,
receipt listing and verification, discovery, and gasless USDC sweep
orchestration. The exact registered union is in
`packages/mcp-server/src/tools.ts`.

The edge signer exposes four local, no-network tools:

| Tool | Purpose |
|---|---|
| `haven_sign` | Sign a prepared payment hash |
| `haven_x402_sign_header` | Sign the decomposed merchant authorization |
| `haven_sign_x402` | Sign the recommended paid-MCP funding and merchant contexts |
| `haven_sign_sweep_delegate` | Sign a gasless delegate-to-wallet USDC sweep |

## Review checklist

- Hosted services never receive a delegate key.
- Setup registration contains public proof and hashed API-key metadata only.
- API-key rotation changes identity credentials, not signing authority.
- Queued or insufficient requests expose no signable hash.
- x402 authorization is bound to amount, merchant, resource, asset, and network.
- Sweep authorization is bound to the registered delegate and Haven wallet.
- Users can pause or revoke in Haven and revoke Safe permissions outside Haven.

## Related docs

- [x402 payment sequence](04-x402-payment-sequence.md)
- [Edge signer](07-edge-signer.md)
- [Local vs hosted MCP](08-local-vs-hosted-mcp.md)
- [CASP / MiCA guardrails](../regulatory/casp-risk-guardrails.md)
