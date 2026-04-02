# Haven — CLAUDE.md

## What Is Haven

Haven is an **agent-first wallet infrastructure layer** for the autonomous economy. It gives AI agents the ability to hold, send, and receive money within strict, user-defined guardrails — without requiring agents to manage private keys or understand blockchain mechanics.

**Core insight:** Agents should NOT be wallets. They should be financial actors with constrained authority. Haven separates the ability to *request* a financial action from the ability to *execute* it, with a policy engine in between.

## Non-Negotiable Design Principles

These are constraints, not suggestions. Every implementation decision must respect them:

1. **Non-Custodial** — User funds live in Safe smart accounts. Haven NEVER holds unrestricted signing authority. If Haven is fully compromised, an attacker still cannot move user funds unilaterally.

2. **Policy-First Execution** — Every financial action gets evaluated against a policy before execution. Nothing hits the blockchain without passing through the policy engine. Policies define: spend limits, allowed assets, approved recipients, time constraints, approval thresholds.

3. **Agent-First Interaction** — Agents talk to Haven through high-level intents (e.g., "pay 50 USDC to 0xabc"), NOT raw blockchain transactions. Haven handles tx construction, encoding, gas, nonces, and execution routing.

4. **Protocol-Native** — Haven integrates natively with x402 (Coinbase) and Stripe MPP. No proprietary payment flows.

5. **Runtime-Agnostic** — Haven makes no assumptions about where agents run. Works with Claude, custom scripts, orchestration frameworks, any agent runtime.

## Architecture — Five Components

```
User → Safe (funds / custody)
Haven → Policy engine + orchestration + protocol adapters
Agent → Requests actions via intents (never touches keys)
Safe → Executes transactions on-chain
Protocols → x402, Stripe MPP (agent payment standards)
```

### 1. Safe (Smart Account)
- Holds funds, executes transactions
- Multi-owner / threshold security
- Deployed on **Gnosis Chain** (POC target)
- Uses Safe SDK for interaction

### 2. Haven Control Layer
- Policy engine (the core of the system)
- Agent identity and credential management
- Transaction construction from intents
- Execution routing (auto-execute vs. approval flow)
- Monitoring and audit logging

### 3. Protocol Adapters
- x402 client (wallet backend for HTTP 402 payments)
- Stripe MPP SPT bridge (future)
- Receipt management

### 4. Execution Primitives
- Safe modules for automated execution
- Guards for transaction validation
- Session keys (future — temporary delegated keys)

### 5. Agents (External Actors)
- Defined by: identity + credential + policy constraints
- Receive portable credentials (API keys), NOT private keys
- Credentials are revocable, time-limited, auditable

## Agent Model

An agent is a **permissioned actor**, defined by:

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

For protocol-based payments (x402/MPP), Haven supports **category-based policies**:

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

Credentials are portable:
```json
{
  "agent_id": "agt_123",
  "secret": "sk_live_xxx",
  "safe_address": "0x...",
  "api_url": "https://api.haven.xyz"
}
```

## Payment Flow

```
1. Agent creates intent → { action: "payment", asset: "USDC", amount: "100", recipient: "0xabc" }
2. Haven validates → checks identity, policy, limits, allowed assets/recipients
3. Haven constructs tx → Safe-compatible ERC20 or native transfer
4. Execution routing:
   - Within policy → auto-execute via module
   - Above threshold → queue for human approval
   - Fails policy → reject, no tx created
5. Response → { status: "executed" | "pending_approval" | "rejected" }
```

### x402 Payment Flow
```
Agent encounters HTTP 402 → forwards to Haven →
Haven policy engine evaluates → Haven signs payment from Safe →
Agent retries with proof → Service delivers resource →
Haven logs receipt
```

## API Surface (POC)

| Endpoint | Method | Description |
|---|---|---|
| `/agents` | POST | Create agent |
| `/agents/{id}/revoke` | POST | Revoke agent |
| `/payments` | POST | Request payment |
| `/payments/{id}` | GET | Get payment status |
| `/transactions` | GET | List transactions |
| `/x402/authorize` | POST | Authorize x402 payment |

## Tech Stack Guidance

- **Chain:** Gnosis Chain (POC target), multi-chain later
- **Smart Accounts:** Safe (use Safe SDK / Safe{Core} Protocol Kit)
- **Language:** TypeScript preferred (aligns with Safe SDK ecosystem)
- **Backend Framework:** Node.js (Express or Fastify)
- **Database:** PostgreSQL (agents, policies, tx logs, audit trail)
- **Auth:** Standard API key auth for agents, web auth for dashboard users
- **Frontend:** Modern web app (React/Next.js) — clean, intuitive, non-technical-friendly

## POC Scope — What To Build First

The POC proves the core model: agents can spend money safely within defined rules.

### POC Feature Set
1. User account creation and authentication
2. Safe smart account deployment on Gnosis Chain
3. Dashboard with linked Safes and consolidated balances
4. Inbound/outbound transaction history
5. Token balance view with main balance denomination
6. Manual transaction sending (connected wallet signing)
7. Agent creation with policy configuration
8. Agent credential (API key) generation and management
9. Safe owner management (add/remove owners)
10. Contact naming / address book
11. **x402 payment authorization** (agent encounters 402, Haven handles payment)

### POC Success Criteria
> A developer can sign up, deploy a Safe, fund it, create an agent with spending policies, and have that agent autonomously pay for an x402-enabled API call — all through a clean, intuitive interface.

## Security Model — Defense in Depth

Multiple independent layers, all need to be compromised for funds to be at risk:

1. **Smart account level** — On-chain ownership, thresholds, module permissions
2. **Policy engine** — Every action checked; policies set by owner, not modifiable by agents
3. **Credential scoping** — Time-bound, limited scope, independently revocable
4. **Approval flows** — Human circuit breaker for high-value actions
5. **Monitoring** — Full audit trail: who requested what, which policy evaluated, what happened

## Phased Development Roadmap

### Phase 1: Core Wallet Infrastructure (POC)
- Agent identity + credentials
- Policy engine (limits, recipients, assets)
- Safe tx construction + execution
- API for agent auth + payments
- Dashboard UI

### Phase 2: Protocol Integration
- x402 client support
- Stripe MPP integration (fiat rails)
- Category-based policies
- Receipt/proof management
- Micropayment optimization (batching)

### Phase 3: Platform & Ecosystem
- Multi-chain support
- Merchant-side payment acceptance
- Third-party SDK
- Multi-agent coordination
- Fiat ↔ crypto bridging

## Key References

- Safe docs: https://docs.safe.global
- Safe modules: https://docs.safe.global/advanced/smart-account-modules
- Safe guards: https://docs.safe.global/advanced/smart-account-guards
- Session keys: https://docs.rhinestone.dev/home/concepts/session-keys
- x402 protocol: HTTP 402-based internet-native payments by Coinbase
- Stripe MPP: Machine Payment Protocol for agent-to-merchant payments

## Code Conventions

- Use TypeScript throughout (backend and frontend)
- Prefer explicit types over `any`
- Use async/await, not callbacks
- Error handling: always return structured error responses from API
- Environment config via `.env` files (never commit secrets)
- Use conventional commit messages
- Document public API endpoints with JSDoc or OpenAPI
