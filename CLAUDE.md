---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/lib/chains.ts
  - packages/backend/src/lib/allowance-module.ts
  - packages/backend/src/middleware/agentAuth.ts
  - packages/backend/src/openapi/spec.ts
  - packages/backend/src/routes/agents.ts
  - packages/backend/src/routes/payments.ts
  - packages/backend/src/routes/safe-deploy.ts
  - packages/backend/src/routes/user-safes.ts
  - packages/backend/src/routes/x402.ts
  - packages/frontend/src/app/globals.css
  - packages/frontend/src/components/ui/Card.tsx
  - packages/frontend/src/components/ui/Row.tsx
  - .github/workflows/dev-gate.yml
  - .github/workflows/publish.yml
  - .github/CODEOWNERS
  - scripts/release-bump.mjs
last-verified: "2026-06-28"
---

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
- **Base** (chain ID 8453) is the **primary / default network**; **Gnosis Chain** (chain ID 100) is also supported
- Two onboarding paths: **in-app deployment** during signup (passkey-owned Safe via `POST /safe/deploy`, or EOA-owned via the connected-wallet flow) and **import** of an existing Safe (`POST /user/safes`)
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
Haven policy engine evaluates → Haven funds the delegate wallet from the Safe →
Agent signs a standard x402 EIP-3009 payment from the delegate wallet →
Agent retries with X-PAYMENT → merchant facilitator settles to merchant →
Haven logs receipt
```

For standard merchant x402, the AllowanceModule transfer is `Safe → delegate EOA`; the merchant-facing settlement is then `delegate EOA → merchant` through EIP-3009. This keeps merchant verification protocol-native, but it means the delegate can briefly hold liquid Base USDC. Treat delegate keys as hot payment keys: rotate them after suspected exposure, keep x402 allowances small and reset-bound, and reconcile/sweep stranded delegate balances when a merchant verifies but does not settle before authorization expiry.

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

- **Chain:** **Base (chain ID 8453) is the primary / default network**; Gnosis Chain (chain ID 100) is also supported (see the registry in `lib/chains.ts`). Multi-chain later. Note: some DB column defaults and route fallbacks still default `chain_id` to `100` (Gnosis) — see migrations and `?? 100` fallbacks; align these to Base if/when Base should be the runtime default for new agents, not just the documented one
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
6. **x402 hot-wallet minimization** — Standard x402 can temporarily fund the delegate EOA so merchants can settle EIP-3009 payments. Keep these balances transient, record the merchant address separately from the funding transfer address, and add reconciliation/sweep handling for stranded funds before scaling high-volume traffic.

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

## Releasing & publishing packages

Five packages are published to npm: `@haven_ai/sdk`, `@haven_ai/signer`, `@haven_ai/mcp`, `@haven_ai/connect` (the connector the dashboard hands out via `npx @haven_ai/connect@alpha`), and `@haven_ai/cli`. `mcp-server`, `backend`, and `frontend` are NOT on npm — they deploy from branches (Railway/Vercel): `main` → production, and the `dev` integration branch → the shared **dev environment** (see [`docs/operations/dev-environment.md`](docs/operations/dev-environment.md)).

> **Branch model:** feature work flows `feature/* → dev → main`. The `dev-gate` workflow only lets `dev` or `hotfix/*` merge into `main`, so open feature PRs into `dev`, not `main`. **`dev` is the default branch**, so issues close on the dev-merge (= implemented); what's in **prod** is tracked by the prod-release + pending-promotion-digest workflows on `main`, not by issue state. Canonical reference: [`docs/contributing/branch-and-release-flow.md`](docs/contributing/branch-and-release-flow.md); PR mechanics: [`docs/contributing/pr-workflow-checklist.md`](docs/contributing/pr-workflow-checklist.md).

- **Never run `npm publish` by hand.** To cut a release, run `npm run release:bump -- <version>` (e.g. `0.1.17-alpha.0`), commit on a release branch, open a PR, and merge. The **Publish packages** workflow (`.github/workflows/publish.yml`) publishes on merge to `main`, choosing the dist-tag from the version (prerelease → `alpha`, stable → `latest`) and skipping any version already on npm.
- **Never hand-edit the version fields or cross-package dep pins.** `release-bump.mjs` is the single source of truth — it updates all five `package.json` versions, the internal dep pins, and the source version constants (`MCP_VERSION`, `SIGNER_VERSION`, `HOSTED_SERVER_VERSION`, `CONNECTOR_VERSION`, `CLI_VERSION`, connect's `runtime-manifest`) atomically, then verifies the connect bundle. Pinning an internal `@haven_ai/*` dep to a wildcard (`*`, `latest`, `workspace:*`) is forbidden — it ships green in-repo but resolves to the wrong version on a user's machine.
- Full procedure: [`scripts/README.md`](scripts/README.md). Runtime-compatibility checklist: [`docs/operations/mcp-runtime-compatibility.md`](docs/operations/mcp-runtime-compatibility.md).

## UI surface hierarchy

No nested filled cards. To group content inside a `Card`, use `Card.Section` (white-on-white hairline) or `Card.Section divided` (row list); for list items use the `Row` primitive. Tinted surfaces (`--v2-surface`, `--v2-surface-2`) are reserved for callouts/banners, table headers (`--v2-table-header-bg`), the `anchor` Card elevation, chips and code blocks, and overlay surfaces (tooltips, popovers, dropdowns, modal subgrids). Don't reach for a grey inner wrapper to "group" siblings — it creates a phantom surface tier and fights the parent Card's lift. See `/design-system` → "Surface hierarchy" for the ❌/✅ comparison.

## Agentic Development Workflow

Use `docs/contributing/ai-agent-workflow.md` for feature delivery, UX feedback iteration, and bug fixing. Agentic delivery is a default workflow decision for non-trivial Haven work, not an opt-in phrase the user must repeat. Keep the main interactive session as captain and use the project agents in `.claude/agents/` for workflow coordination, discovery, bounded implementation, and review when the task shape warrants it.

The captain owns product judgment, shared files, gravity files, git hygiene, final integration, and verification. Use workers only for clean, disjoint slices with explicit file ownership. Inform the user which agents are being used, but do not ask for permission unless there is a real blocker, destructive action, credential risk, or tool limitation.

For shipping a **defined set of PRs** with minimal user input, use the autonomous PR loop: `/loop /ship-next`. Its queue is **GitHub Issues** — standalone tasks labeled `code-quality`, or an epic's sub-issues via `/loop /ship-next epic=#<n>` (the old `docs/backlogs/*.yml` file tracks are retired; see `docs/backlogs/README.md`). It implements, tests, runs haven-reviewer, opens, and reviewer-gated auto-merges each PR — escalating to the user only on a blocking finding, a real decision, a money-path merge (the `.github/CODEOWNERS` carve-out), or stuck CI. You don't have to hand-write those issues: **`/new-task "<description>"`** captures a one-liner as a well-formed backlog issue (Scope + Acceptance + Surface + Money-path), backlog-only by default; **`/ship-next "<description>"`** does the same *and* ships it in one go — the low-friction front door. See `docs/contributing/autonomous-pr-loop.md` (includes the one-time GitHub setup).

**`/ship-next` is the default way to ship anything defined as a GitHub issue or sub-issue.** Say "ship next" and it classifies the issue's surface from its `area:*` / `money-path` labels (Phase 1.5) and loads the matching **playbook** (`docs/contributing/ship-playbooks/`) so the right standards apply without a long prompt — UX + design system for `area:frontend`, CASP for `money-path`, runtime/release rules for `area:sdk`/`area:mcp`, the docs-quality system for `area:docs`. It then runs the Captain Self-Check Preflight before review, keeps implicated docs accurate (coupling gate + haven-doc-reviewer), and opens a PR filled from the template. The skill **routes, it does not contain**: it links the canonical standards rather than copying them. See `docs/contributing/ship-playbooks/README.md`.
