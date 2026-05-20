# Haven — x402 Payment Execution Sequence

How an agent pays for an x402-protected resource through Haven. The interesting
piece is the **left edge** of this diagram — the HTTP 402 challenge from the
resource server — which is what x402 is for. Once Haven is involved, the
mechanics overlap heavily with the normal `/payments` flow but with a few
differences worth knowing.

Source of truth: [packages/backend/src/routes/x402.ts](../../packages/backend/src/routes/x402.ts) and
[packages/backend/src/lib/allowance-module.ts](../../packages/backend/src/lib/allowance-module.ts).

```mermaid
sequenceDiagram
  autonumber
  participant Agent as Agent runtime
  participant Resource as x402 resource<br/>server
  participant API as Haven backend
  participant DB as Postgres
  participant RPC as Gnosis RPC
  participant AM as AllowanceModule
  participant Safe

  Agent->>Resource: GET /protected
  Resource-->>Agent: 402 Payment Required<br/>X-PAYMENT challenge:<br/>{ payTo, amount, asset, network }

  Note over Agent: Agent holds the delegate EOA key.<br/>Signs the transfer hash up front<br/>for one-shot mode.

  Agent->>API: POST /x402/authorize<br/>{ url, payTo, amount, asset, network, category, signature }<br/>Authorization: Bearer sk_agent_*
  API->>DB: SELECT agent WHERE api_key_hash = sha256(key)
  API->>DB: SELECT agent_allowances WHERE token_address = asset

  API->>DB: COUNT payment_intents<br/>(source='x402') in last hour
  alt count ≥ max_x402_per_hour (default 100)
    API-->>Agent: 429 { error: rate limit, retry_after_seconds: 60 }
  else within rate limit
    API->>RPC: AllowanceModule.getTokenAllowance(safe, delegate, asset)
    RPC-->>API: [amount, spent, resetMin, lastResetMin, nonce]

    alt amount > remaining (over allowance)
      API->>DB: INSERT approval_requests<br/>reason includes url + category<br/>expires_at = NOW()+24h
      API-->>Agent: 202 { status: pending_approval, expires_at }
      Note over Agent,API: Agent cannot complete x402 now. User must approve in dashboard. Agent must retry POST /x402/authorize after approval lands.

    else within allowance (one-shot with signature)
      API->>RPC: generateTransferHash(safe, asset, payTo, amount, 0x0, 0, nonce)
      RPC-->>API: sign_hash (bytes32)
      API->>API: ecrecover(sign_hash, signature) == delegate_address ?
      API->>DB: INSERT payment_intents<br/>status = submitted,<br/>source = 'x402',<br/>x402_resource_url = url,<br/>x402_category = category
      API->>RPC: relayer.executeAllowanceTransfer(<br/>safe, asset, payTo, amount,<br/>0x0, 0, delegate, signature)
      RPC->>AM: tx (signed by relayer wallet)
      AM->>Safe: transfer within allowance
      Safe-->>AM: ok
      RPC-->>API: tx_hash, confirmed
      API->>DB: UPDATE status = confirmed,<br/>tx_hash, usd_value, eur_value
      API-->>Agent: 201 { status: confirmed, tx_hash, resource_url, explorer_url }

      Note over Agent,Resource: Agent retries the resource with payment proof
      Agent->>Resource: GET /protected<br/>X-PAYMENT-PROOF: tx_hash
      Resource-->>Agent: 200 OK (resource delivered)
    end
  end
```

## Differences vs the regular `/payments` flow

The on-chain mechanics are identical (same `payment_intents` table, same
`executeAllowanceTransfer`, same delegate signature verification). The x402
endpoint adds four things on top:

| Concern | Regular `/payments` | `/x402/authorize` |
|---|---|---|
| Token resolution | by **symbol** | by **address** (asset field from X-PAYMENT) |
| Amount units | human-readable + decimals | **atomic units** straight from the x402 challenge |
| Rate limit | none | per-agent `max_x402_per_hour` (default 100) — 429 if exceeded |
| Metadata | none | `source='x402'`, `x402_resource_url`, `x402_category` stored on the intent |
| Modes | always two-step (sign separately) | optional **one-shot** when `signature` is included in the body |

## Two-step mode (alternative happy path)

If the agent posts `/x402/authorize` **without** a `signature`, the endpoint
returns `201 { status: 'pending_signature', sign_data }` instead of executing.
The agent then signs `sign_data.hash` with its delegate key and either:

1. `POST /payments/:id/sign` — same path as the regular `/payments` flow
   ([packages/backend/src/routes/payments.ts:264](../../packages/backend/src/routes/payments.ts)), or
2. `POST /x402/authorize` again with the `signature` field — one-shot
   execution against the same nonce.

Both routes converge on `executeAllowanceTransfer` via the relayer wallet.

## Why x402 is not just a `/payments` alias

The protocol-shaped concerns live entirely on the **left half** of the diagram
(the resource server's 402 challenge and the agent's retry with proof). Haven
does not talk to the resource server or any x402 facilitator directly — that
is the agent's job. Haven's contribution is: accept the wire-format inputs
that x402 hands to the agent (atomic amount, asset address, CAIP-2 network),
enforce per-protocol guardrails (rate limit, category tagging), and settle
on-chain in one round-trip when possible.
