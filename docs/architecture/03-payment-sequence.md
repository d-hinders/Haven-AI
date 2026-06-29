---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/routes/payments.ts
  - packages/backend/src/lib/allowance-module.ts
  - packages/backend/src/lib/payment-coverage.ts
  - packages/backend/src/routes/x402.ts
  - packages/backend/src/routes/approvals.ts
  - packages/backend/src/lib/machine-payments.ts
  - packages/backend/src/middleware/agentAuth.ts
  - packages/backend/src/lib/chains.ts
  - packages/frontend/src/hooks/useSendTransaction.ts
  - packages/frontend/src/lib/safe-tx.ts
last-verified: "2026-06-29"
---

# Haven — Payment Execution Sequence

How an agent payment actually flows through the system, from intent to
on-chain settlement. Two branches: **within allowance** (agent signature
required, no user approval) and **over allowance** (queued for user approval
and user-authorized Safe execution).

Source of truth: [packages/backend/src/routes/payments.ts](../../packages/backend/src/routes/payments.ts) and
[packages/backend/src/lib/allowance-module.ts](../../packages/backend/src/lib/allowance-module.ts).

```mermaid
sequenceDiagram
  autonumber
  participant Agent as Agent runtime
  participant Owner as Wallet owner
  participant API as Haven backend
  participant DB as Postgres
  participant RPC as Chain RPC
  participant AM as AllowanceModule
  participant Safe
  participant Service as Safe Transaction Service

  Agent->>API: POST /payments<br/>{ token, amount, to }<br/>Authorization: Bearer sk_agent_*
  API->>DB: Authenticate API-key hash<br/>load agent, Haven wallet, and chain
  API->>DB: Require configured DB token allowance
  API->>RPC: AllowanceModule.getTokenAllowance(safe, delegate, token)
  API->>RPC: Read latest block timestamp
  RPC-->>API: Allowance state + chain time
  API->>API: Compute effective remaining allowance

  alt amount ≤ remaining (signature-ready)
    API->>RPC: AllowanceModule.generateTransferHash(safe, token, to, amount, 0x0, 0, nonce)
    RPC-->>API: payload hash (bytes32)
    API->>DB: INSERT payment_intents<br/>status = pending_signature<br/>expires_at = NOW()+10m
    API-->>Agent: 201 { payment_id, status,<br/>expires_at, sign_data: { hash, ... } }

    Note over Agent: Sign sign_data.hash with the local delegate key
    Agent->>API: POST /payments/:id/sign { signature }
    API->>API: ecrecover(sign_hash, signature) == delegate_address ?
    API->>DB: Atomically claim pending_signature → submitted
    API->>RPC: relayer.executeAllowanceTransfer(<br/>safe, token, to, amount,<br/>0x0, 0, delegate, signature)
    RPC->>AM: tx (signed by relayer wallet)
    AM->>Safe: transfer within allowance
    Safe-->>AM: ok
    alt execution succeeds
      RPC-->>API: tx hash
      API->>DB: UPDATE status = confirmed, tx_hash, confirmed_at
      API-->>Agent: 200 { tx_hash, status: confirmed, explorer_url }
    else execution fails
      API->>DB: UPDATE status = failed, error_message
      API-->>Agent: execution error
    end

  else amount > remaining (pending approval)
    API->>DB: INSERT approval_requests<br/>status = pending<br/>expires_at = NOW()+24h
    API-->>Agent: 202 { payment_id, kind: approval_request,<br/>status: pending_approval, expires_at }
    Owner->>API: POST /approvals/:id/approve
    API->>DB: UPDATE status = approved
    alt threshold-one Haven wallet
      Note over Owner,Safe: Owner signs and executes the Safe transaction
      Owner->>Safe: user-authorized payment
      Owner->>API: POST /approvals/:id/executed { tx_hash }
      API->>DB: UPDATE status = executed
    else multisig Haven wallet
      Owner->>Service: propose Safe transaction for more signatures
      Owner->>API: POST /approvals/:id/proposed
      API->>DB: UPDATE status = proposed
    end
    Note over Agent,Owner: Rejected or expired approvals move no funds
  end
```

## Key invariants in this flow

- **The DB config is an eligibility gate; on-chain state is the spend
  envelope.** Haven requires a configured token allowance row, then reads the
  AllowanceModule state and latest chain timestamp. `computeEffectiveAllowance`
  applies the module's reset semantics, so out-of-band AllowanceModule transfers
  under the same delegate/token allowance are already reflected and reset
  decisions use chain time
  ([packages/backend/src/lib/allowance-module.ts](../../packages/backend/src/lib/allowance-module.ts)).
- **The delegate signature is independently re-verified by the
  AllowanceModule.** Even if the backend skipped its own `ecrecover` check,
  the on-chain module would reject a bad signature.
- **The relayer pays gas for the within-allowance delegate path.** The relayer
  wallet is the `msg.sender`; the delegate signature lives in calldata. The
  owner-approval path instead uses the Haven wallet's configured owner or
  multisig approval/execution method.

## State Lifecycles

- Direct intent: `pending_signature` (10-minute signing window) → `submitted` →
  `confirmed` or `failed`. An unsigned expired intent becomes `expired` and
  cannot execute.
- Owner approval: `pending` (24-hour review window) → `approved` → `executed`
  for threshold-one wallets, or `proposed` while a multisig waits for remaining
  signatures; `rejected` / `expired` are terminal alternatives. Approval does
  not reuse the delegate-relayer path: the wallet owner authorizes the Safe
  transaction and Haven records its result.

## Related: x402 path

`POST /x402/authorize` ([packages/backend/src/routes/x402.ts](../../packages/backend/src/routes/x402.ts))
shares the payment/approval writers and AllowanceModule execution primitive,
but its funding semantics differ:

- Token and chain come from the merchant challenge and must match the agent's
  Haven wallet.
- Coverage is balance-aware. Above `delegate balance + remaining allowance`
  returns 422 without creating payment state; above remaining allowance but
  within total coverage queues for user approval.
- Within allowance, Haven creates a Safe-to-`payTo` funding intent. The merchant
  settlement remains a separate, locally signed x402 step.
- Unsigned mode returns a 10-minute funding intent that can be submitted through
  `/payments/:id/sign`. One-shot mode accepts the funding signature on
  `/x402/authorize` and records confirmation atomically after execution.
- The shared writers persist rail, resource, merchant, idempotency, and resume
  context. A per-agent hourly limit (`max_x402_per_hour`, default 100) applies.
