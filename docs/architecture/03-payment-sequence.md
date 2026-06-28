---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/routes/payments.ts
  - packages/backend/src/lib/allowance-module.ts
  - packages/backend/src/lib/payment-coverage.ts
  - packages/backend/src/routes/x402.ts
last-verified: "2026-06-28"
---

# Haven — Payment Execution Sequence

How an agent payment actually flows through the system, from intent to
on-chain settlement. Two branches: **within allowance** (auto-execute) and
**over allowance** (queued for user approval).

Source of truth: [packages/backend/src/routes/payments.ts](../../packages/backend/src/routes/payments.ts) and
[packages/backend/src/lib/allowance-module.ts](../../packages/backend/src/lib/allowance-module.ts).

```mermaid
sequenceDiagram
  autonumber
  participant Agent as Agent runtime
  participant API as Haven backend
  participant DB as Postgres
  participant RPC as Gnosis RPC
  participant AM as AllowanceModule
  participant Safe

  Agent->>API: POST /payments<br/>{ token, amount, to }<br/>Authorization: Bearer sk_agent_*
  API->>DB: SELECT agent WHERE api_key_hash = sha256(key)
  API->>DB: SELECT agent_allowances for (agent, token)
  API->>RPC: AllowanceModule.getTokenAllowance(safe, delegate, token)
  RPC-->>API: [amount, spent, resetMin, lastResetMin, nonce]

  alt amount ≤ remaining (auto-execute)
    API->>RPC: AllowanceModule.generateTransferHash(safe, token, to, amount, 0x0, 0, nonce)
    RPC-->>API: sign_hash (bytes32)
    API->>DB: INSERT payment_intents<br/>status = pending_signature<br/>expires_at = NOW()+10m
    API-->>Agent: 200 { payment_id, sign_hash, expires_at }

    Note over Agent: Sign sign_hash with delegate EOA key
    Agent->>API: POST /payments/:id/sign { signature }
    API->>API: ecrecover(sign_hash, signature) == delegate_address ?
    API->>DB: UPDATE status = submitted, signature
    API->>RPC: relayer.executeAllowanceTransfer(<br/>safe, token, to, amount,<br/>0x0, 0, delegate, signature)
    RPC->>AM: tx (signed by relayer wallet)
    AM->>Safe: transfer within allowance
    Safe-->>AM: ok
    RPC-->>API: tx_hash, status = confirmed
    API->>DB: UPDATE status = confirmed, tx_hash, confirmed_at
    API-->>Agent: 200 { tx_hash, status: confirmed, explorer_url }

  else amount > remaining (pending approval)
    API->>DB: INSERT approval_requests<br/>status = pending<br/>expires_at = NOW()+24h
    API-->>Agent: 202 { approval_id, status: pending_approval }
    Note over Agent,API: User reviews in dashboard. If approved, the same execute path runs. If rejected or expired, no movement occurs.
  end
```

## Key invariants in this flow

- **The allowance check is on-chain, not DB.** Step 4 reads
  AllowanceModule state directly, so any out-of-band on-chain spend by the
  same delegate is already counted in `spent`
  ([packages/backend/src/lib/allowance-module.ts](../../packages/backend/src/lib/allowance-module.ts)).
- **The delegate signature is independently re-verified by the
  AllowanceModule.** Even if the backend skipped its own `ecrecover` check,
  the on-chain module would reject a bad signature.
- **The relayer pays gas, the agent does not.** The relayer wallet is the
  `msg.sender`; the delegate signature lives in the calldata.
- **Approval expiry is 24h.** After that the `approval_requests` row is dead
  and the agent must re-submit.

## Related: x402 path

`POST /x402/authorize` ([packages/backend/src/routes/x402.ts](../../packages/backend/src/routes/x402.ts))
uses the same `payment_intents` table and the same execute path, plus:

- Token resolved by address rather than symbol
- Per-agent hourly rate limit (`max_x402_per_hour`, default 100, returns 429)
- `source = 'x402'` and `x402_resource_url` stored on the intent
- Optional one-shot mode where the signature is included in the initial
  request so step 7 collapses into step 1
