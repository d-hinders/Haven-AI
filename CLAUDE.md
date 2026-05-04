# Haven — CLAUDE.md

## What Is Haven

Haven is an **agent-first wallet infrastructure layer** for the autonomous economy. It gives AI agents the ability to hold, send, and receive money within strict, user-defined guardrails — without requiring agents to manage private keys or understand blockchain mechanics.

**Core insight:** Agents should NOT be wallets. They should be financial actors with constrained authority. Haven separates the ability to *request* a financial action from the ability to *execute* it, with a policy engine in between.

## Non-Negotiable Design Principles

These are constraints, not suggestions. Every implementation decision must respect them:

1. **Non-Custodial** — User funds live in Safe smart accounts. Haven NEVER holds unrestricted signing authority. If Haven is fully compromised, an attacker still cannot move user funds unilaterally.

2. **Policy-First Execution** — Every financial action is evaluated against the agent's on-chain allowance before execution. The policy *is* the Safe AllowanceModule allowance: per-token amount and reset period. Anything that exceeds the remaining allowance is auto-queued for human approval; nothing executes outside that envelope.

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
- **Gnosis Chain** (POC target)
- Users **import** an existing Safe (via `POST /user/safes`); in-app deployment is not yet a feature
- Interaction is via direct contract calls with `ethers.js` against Safe + the AllowanceModule (no `@safe-global/protocol-kit` yet — see Tech Stack)

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
- **Safe AllowanceModule** — the on-chain policy primitive today. An agent has a `delegate_address`; the user grants per-token allowances to that delegate via the AllowanceModule, and the Haven backend executes spend-from-allowance transfers on the agent's behalf
- Guards for transaction validation (future)
- Session keys (future — temporary delegated keys)

### 5. Agents (External Actors)
- Defined by: identity + credential + policy constraints
- Receive portable credentials (API keys), NOT private keys
- Credentials are revocable, time-limited, auditable

## Agent Model

An agent is a **permissioned actor** = identity + delegate address + a set of per-token on-chain allowances. Authority is enforced by the Safe AllowanceModule, not by an off-chain rules DSL.

```json
{
  "id": "agt_123",
  "name": "Payment Agent",
  "description": "Pays for API calls",
  "delegate_address": "0xDEADBEEF...",
  "safe_id": "saf_456",
  "status": "active",
  "allowances": [
    { "token_symbol": "USDC", "token_address": "0x...", "allowance_amount": "500.000000", "reset_period_min": 1440 },
    { "token_symbol": "EURe", "token_address": "0x...", "allowance_amount": "100.000000", "reset_period_min": 0 }
  ]
}
```

- `allowance_amount` and `reset_period_min` map directly to the on-chain AllowanceModule.
- Payments that fit within the remaining on-chain allowance auto-execute; payments that exceed it are queued for the user to approve manually. There is no separate off-chain `requires_approval_above` knob, no recipient allowlist, and no monthly/per-tx limit on the agent itself.
- Category-based / protocol-based / per-hour-rate policies (x402, MPP categories, etc.) are **future work** (Phase 2), not implemented today.

Credentials are portable:
```json
{
  "agent_id": "agt_123",
  "secret": "sk_live_xxx",
  "safe_address": "0x...",
  "api_url": "https://havenbackend-production-8a00.up.railway.app"
}
```

## Payment Flow

```
1. Agent creates intent → { action: "payment", asset: "USDC", amount: "100", recipient: "0xabc" }
2. Haven authenticates the agent and looks up its on-chain allowance for the requested token
3. Haven constructs tx → AllowanceModule.executeAllowanceTransfer (or native/ERC20 path)
4. Execution routing:
   - Within remaining on-chain allowance → auto-execute as the delegate
   - Exceeds remaining allowance → queue as a pending payment for the user to approve
5. Response → { status: "executed" | "pending_approval" }
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

- **Chain:** Gnosis Chain (POC target, chain ID 100), multi-chain later
- **Smart Accounts:** Safe + AllowanceModule, accessed via direct contract calls with `ethers.js`. Adopting `@safe-global/protocol-kit` is a possible future cleanup, not a current convention
- **Language:** TypeScript throughout
- **Backend Framework:** Fastify (Node.js)
- **Database:** PostgreSQL (agents, allowances, payments, audit trail)
- **Auth:** API key auth for agents, web auth for dashboard users
- **Frontend:** Next.js / React

## POC Scope — What To Build First

The POC proves the core model: agents can spend money safely within defined rules.

### POC Feature Set
1. User account creation and authentication
2. Safe import / linking on Gnosis Chain (users bring an existing Safe)
3. Dashboard with linked Safes and consolidated balances
4. Inbound/outbound transaction history
5. Token balance view with main balance denomination
6. Manual transaction sending (connected wallet signing)
7. Agent creation with per-token on-chain allowances
8. Agent credential (API key) generation and management
9. Safe owner management (minimal in current UI)
10. Contact naming / address book
11. **x402 payment authorization** (agent encounters 402, Haven handles payment)

### POC Success Criteria
> A developer can sign up, link a Safe, fund it, create an agent with on-chain allowances, and have that agent autonomously pay for an x402-enabled API call — all through a clean, intuitive interface.

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
- On-chain allowance enforcement via Safe AllowanceModule (auto-queue over-limit)
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
