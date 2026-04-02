# Haven — Agent-First Wallet (Technical Context)

## Overview

Haven is an agent-first wallet built on top of smart accounts (Safe) that enables users to:

- Give AI agents the ability to spend money — and pay for services autonomously
- Enforce strict policy controls on how that money is used
- Maintain a non-custodial architecture
- Operate across external agent environments (e.g. Claude, OpenClaw, scripts)
- Participate in emerging agent payment protocols (x402, Stripe MPP) as both payer and receiver

**The core idea:**
AI agents should be able to transact, but only within clearly defined, user-controlled rules.
Haven acts as the **wallet infrastructure layer** for the agent economy — not just a payment API, but the policy-aware backend that backs agents participating in internet-native payment protocols.

## Core Principles

### 1. Non-custodial by design

- Funds are held in a Safe smart account
- Haven does not hold unrestricted signing authority
- If Haven is compromised, funds should not be movable

### 2. Policy-based execution

All agent actions are constrained by:

- Spend limits
- Allowed assets
- Allowed recipients
- Approval thresholds
- Time constraints

### 3. Agent-first UX

- Agents interact with Haven via intents, not raw blockchain transactions
- Haven abstracts calldata, token logic, and Safe transaction structure

### 4. External agent compatibility

- Agents can run anywhere (Claude, OpenClaw, scripts)
- Haven provides a portable credential system

### 5. Protocol-native

- Haven speaks the emerging standards of the agent economy: x402 (HTTP 402) and Stripe MPP
- Agents backed by Haven can pay any x402-enabled API or Stripe MPP merchant without custom integration
- Haven can also accept inbound agent payments via these protocols

## Architecture

### Components

- **Safe (Smart Account)** — Holds funds, executes transactions, multi-owner / threshold security
- **Haven (Control Layer)** — Policy engine, agent management, transaction construction, execution orchestration, monitoring & logging
- **Protocol Adapters** — x402 client/facilitator, Stripe MPP SPT bridge, receipt management
- **Execution Primitives** — Safe modules, session keys (future), standard Safe approval flow
- **Agents** — External actors that use Haven credentials and request actions (not raw txs)

## Agent Model

### Agent = Permissioned Actor

An agent is defined by: identity, credential, and policy constraints.

Example:

```json
{
  "name": "Payment Agent",
  "daily_limit": "500 USDC",
  "per_tx_limit": "100 USDC",
  "allowed_assets": ["USDC", "EURe"],
  "allowed_recipients": ["0xabc..."],
  "requires_approval_above": "100 USDC",
  "expiry": "30 days"
}
```

### Agent Credentials

Agents receive a portable credential, not a private key.

```json
{
  "agent_id": "agt_123",
  "secret": "sk_live_xxx",
  "safe_address": "0x...",
  "api_url": "https://api.haven.xyz"
}
```

This credential allows:

- Requesting payments
- Querying balances
- Accessing transaction status

It does NOT allow:

- Unrestricted signing
- Bypassing policies

## Interaction Model

Agents do NOT: build raw transactions, encode calldata, manage nonces, or interact directly with RPC.

Agents DO: send payment intents to Haven.

## Payment Flow

### Step 1 — Agent creates intent

```json
{
  "action": "payment",
  "safeId": "safe_123",
  "asset": "USDC",
  "amount": "100",
  "recipient": "0xabc...",
  "memo": "Invoice 1042"
}
```

### Step 2 — Haven validates

Haven checks: agent identity, policy constraints, limits, allowed assets, and allowed recipients.

### Step 3 — Haven constructs transaction

Haven builds a Safe-compatible transaction: ERC20 transfer or native transfer, correct encoding, correct target.

### Step 4 — Execution routing

**Case A: Auto-executable** — Within policy, executed via module or delegated path (future), sent to network.

**Case B: Needs approval** — Above threshold, created as Safe transaction, awaits owner signatures.

**Case C: Rejected** — Fails policy check, no transaction created.

### Step 5 — Response to agent

```json
{ "status": "executed", "txHash": "0x..." }
```

```json
{ "status": "pending_approval", "safeTxHash": "0x..." }
```

```json
{ "status": "rejected", "reason": "exceeds policy" }
```

## Execution Layer

### Safe Modules

- Enable automated execution
- Enforce rules at execution time
- Allow Safe to execute without full multisig flow
- Docs: https://docs.safe.global/advanced/smart-account-modules

### Guards

- Validate transactions before execution
- Enforce global safety constraints
- Docs: https://docs.safe.global/advanced/smart-account-guards

### Session Keys (future)

- Temporary delegated keys
- Limited by rules, revocable
- Ideal for agents
- Docs: https://docs.rhinestone.dev/home/concepts/session-keys

## Protocol Integration Layer

Haven's policy engine and non-custodial architecture position it as the natural wallet infrastructure behind emerging agent payment standards.

### x402 — HTTP 402 Payment Required

x402 (developed by Coinbase) revives the HTTP 402 status code for internet-native payments. When an agent requests a paid resource, the server responds with `402 Payment Required` including payment terms (price, token, chain, address). The agent pays on-chain and retries with proof.

**Haven as x402 wallet backend:**

The critical gap in x402 is: *who controls the wallet that backs the agent's payment?* By default, the agent needs a funded wallet and signing capability — no policy controls, no spend limits. Haven fills this gap.

- Haven exposes an x402-compatible signer/client module
- When an agent encounters a 402, the payment authorization routes through Haven's policy engine
- Haven checks: is this agent allowed to spend this amount, on this asset, for this type of service?
- If approved, Haven constructs and signs the on-chain payment from the Safe
- The agent never holds keys — it just speaks HTTP 402

**x402 session support (V2):**

x402 V2 introduces sessions (authenticate once, pay repeatedly). Haven's agent credential model maps directly to this — a Haven credential can serve as an x402 session identity, with Haven enforcing cumulative spend limits across the session.

**Haven as x402 facilitator (merchant-side):**

For merchants or services using Haven-managed Safes to receive payments, Haven can act as an x402 facilitator — verifying inbound payment proofs and settling funds into the Safe.

### Stripe MPP — Machine Payments Protocol

Stripe's MPP (co-authored with Tempo) is an open standard for agent-to-merchant payments. It uses the same HTTP 402 flow but is rail-agnostic — supporting fiat (cards, BNPL) and stablecoins via Shared Payment Tokens (SPTs). SPTs are scoped, time-limited, usage-capped authorization tokens.

**Haven credentials ↔ SPTs:**

Haven's agent credential model (identity + policy constraints + expiry) is structurally equivalent to Stripe's SPTs. This creates two integration paths:

1. **Haven agents → Stripe merchants (outbound):** Haven generates SPT-compatible tokens so Haven-backed agents can purchase from any Stripe-integrated merchant. This bridges Haven's on-chain policy engine to the entire Stripe merchant ecosystem — millions of vendors, no custom integration per merchant.

2. **Stripe agents → Haven merchants (inbound):** Services using Haven-managed Safes can accept MPP payments from any MPP-speaking agent. Haven validates the SPT, confirms the PaymentIntent, and routes settled funds into the Safe.

**Fiat ↔ crypto bridging:**

MPP's rail-agnostic design means Haven can offer agents the choice: pay on-chain (native) or pay via Stripe (fiat). This is powerful for agents that need to interact with both crypto-native services (x402) and traditional merchants (MPP/Stripe).

### Policy Model for Protocol Payments

Traditional Haven policies use explicit recipient whitelists (`allowed_recipients`). Protocol-based payments require a more flexible model since agents pay *unknown services on demand*.

Haven introduces **category-based policies** for protocol payments:

```json
{
  "name": "Research Agent",
  "daily_limit": "50 USDC",
  "per_tx_limit": "5 USDC",
  "allowed_protocols": ["x402", "mpp"],
  "allowed_categories": ["api_access", "data", "compute"],
  "max_transactions_per_hour": 100,
  "requires_approval_above": "10 USDC",
  "expiry": "7 days"
}
```

This allows agents to pay for API calls, inference, data feeds, and tools without pre-approving every recipient — while still enforcing budgets and rate limits.

### Micropayment Optimization

Both x402 and MPP are designed for high-frequency, low-value transactions (sub-dollar API calls, per-query pricing, pay-per-token inference). Haven optimizes for this via:

- **Batched settlement** — Aggregate many small payments into periodic Safe transactions to reduce gas costs
- **Payment channels / tabs** — For repeated interactions with the same service, open a channel and settle periodically
- **Receipt management** — Store and serve x402/MPP receipts for auditability and dispute resolution
- **Rate-limited execution** — Policy engine enforces transaction frequency caps to prevent runaway spend

## Key Design Decision

**Agent should NOT hold a wallet.**

Instead: Agent holds a capability to request financial actions.

Haven translates that into valid Safe transactions and policy-compliant execution.

## Why This Model Works

- **Simplicity** — Agents use simple APIs, no blockchain complexity
- **Safety** — Policies enforced centrally, Safe remains secure
- **Flexibility** — Supports any agent runtime, portable credentials
- **Extensibility** — Supports human approvals, automation, and hybrid flows

## API Surface (conceptual)

### Core

| Endpoint | Method | Description |
|---|---|---|
| `/agents` | POST | Create Agent |
| `/agents/{id}/revoke` | POST | Revoke Agent |
| `/payments` | POST | Request Payment |
| `/payments/{id}` | GET | Get Payment Status |
| `/transactions` | GET | List Transactions |

### Protocol Integration

| Endpoint | Method | Description |
|---|---|---|
| `/x402/authorize` | POST | Authorize an x402 payment (agent-side) |
| `/x402/verify` | POST | Verify an x402 payment proof (facilitator-side) |
| `/mpp/spt` | POST | Generate a Shared Payment Token for Stripe MPP |
| `/mpp/challenge` | POST | Issue an MPP challenge (merchant-side) |
| `/protocols/discover` | GET | List supported payment protocols for an agent |
| `/receipts` | GET | List payment receipts (x402 + MPP) |
| `/receipts/{id}` | GET | Get receipt detail / proof |

## Core Mental Model

```
User → Safe (funds)
Haven → policies + orchestration + protocol adapters
Agent → requests actions (direct or via x402/MPP)
Safe → executes transactions
```

### Protocol Payment Flow

```
Agent encounters HTTP 402 (x402 or MPP)
  → Haven policy engine evaluates (budget, category, rate limit)
  → Haven signs/authorizes payment from Safe
  → Agent retries request with proof/SPT
  → Service delivers resource
  → Haven logs receipt
```

## Key Insight

AI agents should not be wallets. They should be financial actors with constrained authority.

Haven enables this by:

- Separating intent from execution
- Enforcing policy before money moves
- Keeping custody at the smart account level

## Future Extensions

### Near-term
- x402 client library (agent-side wallet backend)
- Stripe MPP SPT generation for outbound fiat payments
- Category-based policy engine (beyond recipient whitelists)
- Receipt and proof management API
- Micropayment batching and settlement optimization

### Medium-term
- x402 facilitator mode (merchant-side payment acceptance)
- MPP inbound payment acceptance for Haven-managed Safes
- Session key-based direct execution (x402 V2 session support)
- OAuth-style "Connect Haven" for third-party integrations
- Cross-chain support (Base, Solana, other x402-supported networks)

### Long-term
- Multi-agent coordination and inter-agent payment channels
- Automated treasury management
- Fiat ↔ crypto bridging (agents choose rail per transaction)
- Agent-to-agent marketplace settlement
- Embedded payments SDK for external products

## Summary

Haven is an agent-first programmable wallet and protocol infrastructure layer where:

- Users retain custody via Safe
- Agents can spend within defined policies — both for direct payments and protocol-based purchases
- Haven translates intent into safe execution, whether the intent comes from the agent directly or via an x402/MPP flow
- The system speaks the emerging standards of the agent economy natively
- The system remains flexible, secure, and extensible

**The long-term vision:**
A world where AI agents can safely and autonomously participate in financial systems — paying for APIs, services, and goods across both crypto and fiat rails — without compromising user control. Haven is the wallet infrastructure that makes this possible.
