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
  - .agents/skills/**
  - .claude/agents/**
  - .claude/commands/**
last-verified: "2026-07-27"
---

# Haven — CLAUDE.md

## What Is Haven

Haven is an **agent-first wallet infrastructure layer** for the autonomous economy. It gives AI agents the ability to hold, send, and receive money within strict, user-defined guardrails — without requiring agents to manage private keys or understand blockchain mechanics.

**Core insight:** Agents should NOT be wallets. They should be financial actors with constrained authority. Haven separates the ability to *request* a financial action from the ability to *execute* it, with a policy engine in between.

## Non-Negotiable Design Principles

These are constraints, not suggestions. Every implementation decision must respect them:

1. **Non-Custodial** — User funds live in Safe smart accounts. Haven NEVER holds unrestricted signing authority. If Haven is fully compromised, an attacker still cannot move user funds unilaterally.

2. **Policy-First Execution** — Every financial action is evaluated against on-chain policy before execution, never an off-chain rules DSL. Haven runs **two policy rails**, both enforced on-chain: the **delegation rail** (the base for new accounts, epic #821) where the policy is a signed MetaMask delegation with audited caveat enforcers (period budget, recipient pin, expiry) enforced by the DelegationManager during redemption; and the **legacy AllowanceModule rail** (import-only, existing Safes) where the policy *is* the Safe AllowanceModule allowance — per-token amount and reset period, with over-limit spend auto-queued for human approval. (The Smart Sessions **session rail is retired**, #834 — see Execution Primitives.) Nothing executes outside the account's on-chain envelope on either rail.

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
- Two onboarding paths: **in-app deployment** during signup (passkey-owned Safe via `POST /safe/deploy`, or EOA-owned via the connected-wallet flow) and **import** of an existing Safe (`POST /user/safes`). On the delegation rail, signup instead provisions a passkey-owned **Hybrid DeleGator** via `POST /accounts/hybrid` (counterfactual, zero tx — dark-launched, #886)
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
- **Safe AllowanceModule (legacy, import-only)** — the on-chain policy primitive for existing imported Safes (dev-pilot); no new accounts get it. An agent has a `delegate_address`; the user grants per-token allowances to that delegate via the AllowanceModule, and the Haven backend executes spend-from-allowance transfers on the agent's behalf
- Guards for transaction validation (future)
- **Session rail (retired, #834):** the Smart Sessions / ERC-7579 session-key rail is retired outright — its backend modules are deleted, and accounts still marked `execution_rail='session_key'` get HTTP 410 (fail-closed, nothing written) from `POST /payments` and the x402 machine-payment path. New accounts onboard on the delegation rail below. The typed rail seam (`lib/execution-rail.ts`) stays for reversibility
- **Delegation rail (epic #821):** new accounts can be provisioned as MetaMask Hybrid DeleGator smart accounts (`account_type='delegator_hybrid'`, `execution_rail='delegation'`) with policy as signed delegations + audited caveat enforcers. Payments redeem the agent's budget delegation via sponsored UserOps (#829): budget (with native period refill), recipient and expiry are enforced ON-CHAIN during gas estimation — no coverage arithmetic, no approval queue, no schedule machinery on this rail. Grant = 1 owner signature, 0 owner tx (activation relayer-deploys the counterfactual delegator, #860). Security model: `docs/security/delegation-rail-security-model.md`
- **Passkey accounts + recovery (epic #836, shipped):** delegation-rail accounts can be pure-passkey (P256/WebAuthn, no EOA anywhere) — onboarding is one Face ID prompt with zero transactions (dark-launched: `NEXT_PUBLIC_DELEGATION_ONBOARDING=1`), budget grants/revokes sign via WebAuthn, and the account's **signer set** is user-managed (`/agents/:id/account-signers/*`: enroll a backup passkey/EOA, remove — every change signed by an EXISTING signer, never Haven). Recovery = the backup enrolls a replacement and removes the lost key; a removed key's delegations die with it (EIP-1271). The account enforces ≥2 signers on-chain; single-signer accounts have NO recovery. Mainnet gate `#908` is ENFORCED in code (`lib/mainnet-gate.ts`): on value-bearing chains (fail-closed — any non-testnet), provisioning and grant activation refuse accounts below 2 signers unless an explicit waiver was recorded (`user_safes.single_signer_waiver_at`, migration 046); testnets are unaffected. User docs: `docs/product/account-recovery.md`
- **Agent Passport (epic #970, L0 shipped):** an opt-in, signed EAS attestation that an agent was **issued** by Haven, **bound** to a treasury, **governed** by on-chain-enforced controls, and **revocable** — governance metadata, never spend authority, never *verified* (that word is reserved for the unissuable L2 tier). Opt-in at agent creation (`POST /agents`' `issue_passport`) or through the connect flow (`issue_passport` on the setup, acted on once `POST /agent-connection-setups/register` creates the agent, #1072); status renders on the agent detail page (standing + on-chain anchor state, never collapsed into one badge — the DB's `standing` is authoritative, the chain lags). Revocation is automatic and derived from agent revoke, not a separate control. Product doc: `docs/product/agent-passport.md`

> **Owner decision (#834, recorded verbatim):** "Legacy AllowanceModule stays as an IMPORT-ONLY path for existing Safes (dev-pilot); no new accounts get it. Sweep machinery and the delegate-balance monitor stay while any funding-leg rail lives. Session rail retired outright — zero external customers, retirement not migration. Decided by the owner in-session 2026-07-12."

### 5. Agents (External Actors)
- Defined by: identity + credential + policy constraints
- Receive portable credentials (API keys), NOT private keys
- Credentials are revocable, time-limited, auditable

## Agent Model

An agent is a **permissioned actor** = identity + delegate address + on-chain policy. Authority is enforced on-chain, not by an off-chain rules DSL. Which primitive holds the policy depends on the account's rail:
- **Delegation rail (`account_type='delegator_hybrid'`, the base for new accounts):** authority is a signed budget delegation (period budget + optional recipient pin + expiry) redeemed through the DelegationManager. Budgets refill natively at the period boundary — no Haven cron, no approval queue, no schedule machinery. Managed via `/agents/:id/delegations/*` (#828) and the dashboard budget card (#833).
- **Legacy AllowanceModule rail (import-only, existing accounts):** authority is the set of per-token on-chain allowances described below. No new accounts get this rail.

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

- `allowance_amount` and `reset_period_min` map directly to the on-chain AllowanceModule. On the **delegation rail** the same `allowances` array in API payloads is a derived VIEW of the agent's **active** `agent_delegations` rows (#1090) — `agent_allowances` is only written at connection setup on that rail and is never read back for display, and enforcement is the on-chain delegation either way.
- Payments that fit within the remaining on-chain allowance auto-execute; payments that exceed it are queued for the user to approve manually. There is no separate off-chain `requires_approval_above` knob and no monthly/per-tx limit on the agent itself.
- **Lifecycle:** connect-modal agents are created `pending_approval` and flip to `active` inside the FIRST budget approval — the wallet-approval transaction on the legacy rail, the first budget-grant activation on the delegation rail (#1069). Direct `POST /agents` creations start `active`.
- **Recipient pinning:** on the delegation rail, an agent's allowed recipient lives in the delegation's caveat enforcers (per-budget recipient pin), not a separate table. The session-rail `agent_recipients` table + route were dropped in #880 (dead after the #834 retirement).
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

The flow branches on the account's `execution_rail` (resolved from agent auth). Both live rails keep the same agent-facing intent. Accounts still marked `execution_rail='session_key'` get **HTTP 410** ("the session rail is retired — re-onboard on the delegation rail") from `POST /payments` and the x402 machine-payment path — fail-closed, nothing written (#834).

**Delegation rail (`execution_rail='delegation'`, the base for new accounts):**
```
1. Agent creates intent → { action: "payment", asset: "USDC", amount: "100", recipient: "0xabc" }
2. Haven authenticates the agent and selects its budget delegation for that token/recipient
3. Haven prepares a redeeming UserOp; budget, recipient and expiry are enforced ON-CHAIN
   by the caveat enforcers during gas estimation — over-budget/wrong-recipient reverts here,
   no coverage arithmetic and no approval queue
4. The agent signs the account's exact EIP-712 typed data VERBATIM (never a bare hash — the
   #829 lesson); Haven submits the sponsored UserOp. Funds move account→recipient directly,
   no funding leg
5. Response → { status: "executed", tx }   (or a revert if it breached the on-chain policy)
```

**Legacy AllowanceModule rail (import-only, existing accounts):**
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

x402 settlement branches on the account's rail, and the merchant-facing scheme differs per rail.

**Delegation rail (new accounts) — ERC-7710 direct settlement:**
```
Agent encounters HTTP 402 → POST /x402/authorize (rail resolved from agent auth) →
Haven builds a settlement CHILD delegation (exact amount, payee pin, short expiry,
  and a redeemer pin to the 402's advertised `extra.facilitatorAddresses` when present, #1058)
  re-delegated from the agent's budget delegation → agent signs the EIP-712 typed data →
POST /x402/:id/settle → Haven assembles the merchant X-PAYMENT header (MetaMask x402
  `erc7710` payload) → agent retries → merchant redeems the [child, budget] chain and
  settles account→merchant DIRECTLY (no funding leg, no delegate hot balance, no sweep) →
Haven logs receipt
```
The period budget is metered by the settlement itself; over-budget/wrong-recipient reverts on-chain (`lib/x402-delegation.ts`, `routes/x402.ts`). **Caveat — merchant reach:** erc7710 requires facilitator-side support to redeem the chain, and adoption is still thin (≈every real x402 merchant is EIP-3009-only). The **EIP-3009 fallback (#946, RFC #791 §18) is BUILT**: a delegation-metered two-leg where the budget delegation is redeemed to transiently fund the agent EOA, which signs the standard EIP-3009 header. The scheme is selected per payment by the authorize request's payTo shape (merchant payTo → erc7710 direct settlement; payTo = the agent's own delegate EOA + `merchantPayTo` → 3009-mode; optional explicit `settlementScheme` is validated against the shape). 3009-mode structurally requires an **open (unpinned) budget** — a recipient-pinned delegation cannot fund the EOA, so pinned agents are erc7710-only (owner decision 2026-07-15). The bridge deliberately reintroduces a bounded funding leg: budget metered at the funding hop, transient EOA hot balance, sweep/monitor machinery reused (`settlement_scheme: 'eip3009'` recorded in intent metadata for observability). erc7710 remains the destination.

**Legacy AllowanceModule rail (import-only) — EIP-3009 two-leg:**
```
Agent encounters HTTP 402 → forwards to Haven →
Haven policy engine evaluates → Haven funds the delegate wallet from the Safe →
Agent signs a standard x402 EIP-3009 payment from the delegate wallet →
Agent retries with X-PAYMENT → merchant facilitator settles to merchant →
Haven logs receipt
```

For legacy-rail merchant x402, the AllowanceModule transfer is `Safe → delegate EOA`; the merchant-facing settlement is then `delegate EOA → merchant` through EIP-3009. This keeps merchant verification protocol-native, but it means the delegate can briefly hold liquid Base USDC. Treat delegate keys as hot payment keys: rotate them after suspected exposure, keep x402 allowances small and reset-bound, and reconcile/sweep stranded delegate balances when a merchant verifies but does not settle before authorization expiry. (The same hot-balance/sweep discipline applies to the #946 EIP-3009 bridge when it lands on the delegation rail.)

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

- **Chain:** **Base (chain ID 8453) is the primary / default network**; Gnosis Chain (chain ID 100) is also supported. The chain/token FACTS (contracts, explorer/Safe URLs, token data) live in `packages/core/src/chains.ts` (`@haven_ai/core`, #986) — `packages/backend/src/lib/chains.ts` layers env wiring (RPC/API keys) and `packages/frontend/src/lib/chains.ts` layers viem construction on top; both are snapshot-pinned against the shared registry. Multi-chain later. The documented default is also the **runtime** default (#990): `DEFAULT_CHAIN_ID` in `@haven_ai/core` is the single home for it, migration `034_base_default_chain` set the `user_safes` / `payment_intents` / `approval_requests` column defaults to Base for future rows (existing rows keep their stored chain — a live Gnosis Safe stays on Gnosis), and a guard test flags new bare numeric chain fallbacks in the shapes it covers (`??`/`||` incl. quoted, default bindings, ternaries, `if (!x) x =` conditional assignment, SQL `COALESCE`, and trailing call/SQL args for the unambiguous Base ids — widened by #1046, which also line-scoped the allowlist and extended the scan to `packages/core`) — still a partial net whose limits are documented in the guard itself, not a closed guarantee. Two deliberate exceptions: `routes/hybrid-accounts.ts` defaults to Base **Sepolia** while delegation onboarding is dark-launched, and `HAVEN_DEPLOY_CHAIN_IDS` (#679) separately scopes which chains a deployment will *serve* — a default is what you get when you say nothing, the served set is what you may ask for
- **Smart Accounts:** MetaMask Hybrid DeleGator (delegation rail, new accounts) via `@metamask/smart-accounts-kit` + `permissionless`/`viem`; Safe + AllowanceModule (legacy, import-only) accessed via direct contract calls with `ethers.js`. Adopting `@safe-global/protocol-kit` is a possible future cleanup, not a current convention. Smart Sessions / ERC-7579 is retired (#834) — do not add code against it
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
- Session keys (Rhinestone Smart Sessions — retired rail, #834; historical reference only): https://docs.rhinestone.dev/home/concepts/session-keys
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
- Every new doc under `docs/` (and the root gravity files) needs front-matter (`owner` / `status` / `covers` / `last-verified`) — run `npm run docs:new -- <path>` to scaffold it correctly, then fill in `covers` and the body

## Releasing & publishing packages

Five packages are published to npm: `@haven_ai/sdk`, `@haven_ai/signer`, `@haven_ai/mcp`, `@haven_ai/connect` (the connector the dashboard hands out via `npx @haven_ai/connect@alpha`), and `@haven_ai/cli`. `mcp-server`, `backend`, and `frontend` are NOT on npm — they deploy from branches; `@haven_ai/core` is a **private workspace package** (never published — the shared kernel backend/frontend consume with a `"*"` pin, outside `release-bump.mjs` entirely) (Railway/Vercel): `main` → production, and the `dev` integration branch → the shared **dev environment** (see [`docs/operations/dev-environment.md`](docs/operations/dev-environment.md)).

> **Branch model:** feature work flows `feature/* → dev → main`. The `dev-gate` workflow only lets `dev` or `hotfix/*` merge into `main`, so open feature PRs into `dev`, not `main`. **`dev` is the default branch**, so issues close on the dev-merge (= implemented); what's in **prod** is tracked by the prod-release + pending-promotion-digest workflows on `main`, not by issue state. Canonical reference: [`docs/contributing/branch-and-release-flow.md`](docs/contributing/branch-and-release-flow.md); PR mechanics: [`docs/contributing/pr-workflow-checklist.md`](docs/contributing/pr-workflow-checklist.md).

- **Never run `npm publish` by hand.** To cut a release, run `npm run release:bump -- <version>` (e.g. `0.1.17-alpha.0`), commit on a release branch, open a PR, and merge. The **Publish packages** workflow (`.github/workflows/publish.yml`) publishes on merge to `main`, choosing the dist-tag from the version (prerelease → `alpha`, stable → `latest`) and skipping any version already on npm.
- **Never hand-edit the version fields or cross-package dep pins.** `release-bump.mjs` is the single source of truth — it updates all five `package.json` versions, the internal dep pins, and the source version constants (`MCP_VERSION`, `SIGNER_VERSION`, `HOSTED_SERVER_VERSION`, `CONNECTOR_VERSION`, `CLI_VERSION`, connect's `runtime-manifest`) atomically, then verifies the connect bundle. Pinning an internal `@haven_ai/*` dep to a wildcard (`*`, `latest`, `workspace:*`) is forbidden **in the published packages** (sdk/signer/mcp/connect/cli) — it ships green in-repo but resolves to the wrong version on a user's machine. The rule is the **opposite** for private workspace consumers (`backend`, `qa-agent`): they MUST use `"*"` so npm always links the workspace package. Exact-pinning a private consumer is the bug — the pin holds only while the workspace version happens to match; the next `release:bump` makes it unsatisfiable and `npm ci` silently flips to the stale npm registry tarball (this broke the money-flow QA on 2026-07-13: the registry SDK's x402 matcher predated Base-Sepolia support).
- Full procedure: [`scripts/README.md`](scripts/README.md). Runtime-compatibility checklist: [`docs/operations/mcp-runtime-compatibility.md`](docs/operations/mcp-runtime-compatibility.md).

## UI surface hierarchy

No nested filled cards. To group content inside a `Card`, use `Card.Section` (white-on-white hairline) or `Card.Section divided` (row list); for list items use the `Row` primitive. Tinted surfaces (`--v2-surface`, `--v2-surface-2`) are reserved for callouts/banners, table headers (`--v2-table-header-bg`), the `anchor` Card elevation, chips and code blocks, and overlay surfaces (tooltips, popovers, dropdowns, modal subgrids). Don't reach for a grey inner wrapper to "group" siblings — it creates a phantom surface tier and fights the parent Card's lift. See `/design-system` → "Surface hierarchy" for the ❌/✅ comparison.

**Design-lint gate (#855):** frontend CI fails on NEW violations in product-app surfaces across two rule families. **Token rules** catch a bypassed design token: raw Tailwind palette classes (`text-amber-500`, …), hardcoded hex colours, and new `text-[10px]`/`text-[11px]`. **Structural rules (#899)** catch a re-hand-rolled component (the debt epic #859 cleaned): a hand-rolled grey header band (use `Card.Header`), a raw `<table>` (use the `Table` primitive), an inline `<svg>` (use `Icon` + a lucide glyph), and a hand-rolled `${a.slice(0,6)}…${a.slice(-4)}` address slice (use `<Address>`); each structural rule exempts its own primitive's home file. Marketing/landing surfaces (`components/brand`, `components/marketing`, the landing page, `/protocols`, `/investor-briefing`, `/how-it-works`) are intentionally bespoke and exempt from all rules (#874). Existing debt is ratcheted in `packages/frontend/design-lint-baseline.json` (shrink-only). Route colours through `var(--v2-…)` tokens and reach for the shared primitive; check locally with `npm run design:lint -w packages/frontend`.

**Design-quality workflow v2 (epic #904):** design-lint is one of five guards. Also enforced: **visual regression** — `/design-system` is pixel-compared against committed Linux baselines on every frontend PR (blocking; update baselines via the *Update visual baselines* workflow_dispatch on the PR branch, never commit macOS-rendered ones); **design-system coupling** (#898) — a new `ui/`/`haven/` export must appear on `/design-system` in the same PR (blocking on every PR via the *Design-system coupling (strict)* check, #1023, with a sticky comment explaining the finding; escape: `// design-system-exempt: <reason>`); **copy-lint** (#902) — blocking, shrink-only baseline in `packages/frontend/copy-lint-baseline.json` (`npm run lint:copy`); **rendered review** (#900) — `area:frontend` diffs get a `haven-design-reviewer` pass over the `npm run screenshot` evidence in addition to `haven-reviewer`, and a finding from either pauses auto-merge; and the **pattern-absorption preflight** (#901) — extract a repeated markup shape into a primitive on its 2nd occurrence. A weekly non-gating `qa-explore-ui` cadence (#903, `docs/operations/qa-explore-ui-cadence.md`) feeds UX findings into the backlog. Full process: `docs/contributing/ship-playbooks/frontend.md`.

## Agentic Development Workflow

Use `docs/contributing/ai-agent-workflow.md` for feature delivery, UX feedback iteration, and bug fixing. Agentic delivery is a default workflow decision for non-trivial Haven work, not an opt-in phrase the user must repeat. Portable workflow policy and role instructions live in `.agents/skills/`; `.claude/commands/` and `.claude/agents/` are thin Claude Code adapters. Keep the main interactive session as captain and use the canonical Haven roles for workflow coordination, discovery, bounded implementation, and review when the task shape warrants it.

The captain owns product judgment, shared files, gravity files, git hygiene, final integration, and verification. Use workers only for clean, disjoint slices with explicit file ownership. Inform the user which agents are being used, but do not ask for permission unless there is a real blocker, destructive action, credential risk, or tool limitation.

For shipping a **defined set of PRs** with minimal user input, use the canonical `ship-next` skill. In Claude Code, `/loop /ship-next` repeatedly invokes its thin slash-command adapter. The queue is **GitHub Issues** — standalone tasks labeled `code-quality`, or an epic's sub-issues via `epic=#<n>` (the old `docs/backlogs/*.yml` file tracks are retired; see `docs/backlogs/README.md`). It implements, tests, runs haven-reviewer, opens, and reviewer-gated auto-merges each PR — escalating to the user only on a blocking finding, a real decision, a migration merge, or stuck CI. You don't have to hand-write those issues: the canonical `new-task` skill captures a one-liner as a well-formed backlog issue, backlog-only by default; `ship-next "<description>"` does the same and ships it. Claude Code exposes these as `/new-task` and `/ship-next`.

### How shipping is governed (#1025)

`ship-next` is the **default route** — the fastest way through the standards — not a mandate. Three tiers, and it matters which is which:

1. **Enforced by GitHub, whatever opened the PR.** Required status checks (tests/typecheck/build, the docs and design-system gates, visual regression, copy lint) plus the `CODEOWNERS` review rule on `/packages/backend/src/db/migrations/`, and `gate` + `qa-freshness` on `dev → main` promotion. **The authoritative list is the ruleset inventory in [`docs/contributing/autonomous-pr-loop.md`](docs/contributing/autonomous-pr-loop.md)** — read it there and do not restate it here; a second copy drifts, which is the failure this whole section exists to remove. Two caveats it records and this summary would otherwise flatten: a few checks are repo-guarded off on **fork** PRs, and `qa-freshness` has documented bypasses (`qa-override`, `hotfix/*`, admin merge) — "required" is not the same as "unskippable".

2. **What `ship-next` adds on top.** Playbook routing by `area:*` / `money-path` label (UX + design system for `area:frontend`, CASP for `money-path`, runtime/release rules for `area:sdk`/`area:mcp`, docs-quality for `area:docs`); the Captain Self-Check Preflight; the **independent review passes** — `haven-reviewer`, plus `haven-design-reviewer` on `area:frontend`; the `covers:` doc-reviewer step; a PR filled from the template; and closeout with acceptance-criteria evidence. This is judgement work. **CI does not do any of it**, and no check will tell you it was skipped.

3. **Opting out is allowed.** A contributor or agent that prefers another workflow is free to use it — the tier-1 gates still apply, because they are on the PR rather than in anyone's tooling. What you take on is tier 2: skipping the route means owning an equivalent review yourself, not skipping review. Say so in the PR.

The skill **routes, it does not contain**: it links canonical standards rather than copying them. Deliberately **not** built: any check that asks whether `ship-next` was used. Enforce outcomes, never tooling — a gate that can be satisfied by using the right tool rather than doing the right work measures the wrong thing.
