---
owner: "@d-hinders"
status: current
covers:
  - .env.dev.example
  - packages/qa-agent/**
  - packages/frontend/src/lib/api.ts
  - packages/backend/src/lib/allowance-module.ts
last-verified: "2026-06-28"
---

# Agent QA — running the QA layers against the dev environment

The home doc for the automated, agent-based QA flow (epic #573). It lets a
contributor reproduce a QA run against the shared **dev environment**: which URLs
to target, how the backend override works, what credentials/funding are needed,
and how the layers connect. Companion to
[`dev-environment.md`](./dev-environment.md) (how the dev stack is wired).

> **Verify the stack first.** Do not start a QA run until the dev-stack
> verification checklist on #574 is green. The dev backend, demo-merchant and
> hosted MCP are deployed and auto-deploy from `dev` (verified); the open items
> are the **real dev frontend URL**, the **funded QA delegate**, and the `QA_*`
> secrets — plus retiring the stale `dev-backend.up.railway.app` duplicate.

## Targets

The dev **backend** stack has stable Railway URLs; the dev **frontend** has **no
permanent URL** — it is a per-PR Vercel preview link that changes on every
deployment. Pass the preview link in per run (e.g. as `PLAYWRIGHT_BASE_URL` / the
Layer 1 `base_url` input), and confirm the backend host in the Railway dev project.

| Surface | URL | Used by |
|---|---|---|
| Dev frontend | **Per-PR Vercel preview link** — changes each deploy, no permanent URL; Preview scope sets `NEXT_PUBLIC_HAVEN_ENV=dev`. ⚠️ *not* `haven-dev.vercel.app` (a different "HAVEN Project" app). | Layer 1 (#576), Layer 3 (#579) |
| Dev backend / API | `https://havenbackend-dev-8b95.up.railway.app` (⚠️ *not* `dev-backend.up.railway.app`, a stale duplicate) | All layers (the stable API money flows hit) |
| Dev demo-merchant | `https://demo-merchant-dev-84e4.up.railway.app` (`/healthz` verified online) | Layer 2a (#575) x402 settlement |
| Dev MCP | `haven-ai-hosted-mcp-dev-<hash>.up.railway.app` (confirm the hash in Railway) | Layer 2b (#577) |

## Two ways the layers reach the backend — they differ on CORS

This distinction decides what each layer depends on:

- **Node → API (server-to-server):** the seed script (#574) and the money-flow
  harness (#575) call the backend **directly** at
  `HAVEN_API_URL=https://havenbackend-dev-8b95.up.railway.app`. No browser, **no CORS** — so
  these layers do **not** depend on the CORS fix (#585). Their blockers are the
  **demo-merchant on dev** and the **funded delegate / secrets**.
- **Browser (cross-origin):** the live UI smoke (#576) and browser-exploration
  (#579) drive a real browser against the **frontend** URL. To re-point a frontend
  at the shared dev backend they append `?apiBaseUrl=<dev-backend>` — a **browser
  cross-origin** call, so these layers **do** depend on the CORS fix (#585).

## The `?apiBaseUrl` override (gated — #582/#583)

A frontend can be re-pointed at a chosen backend at runtime:

- `…?apiBaseUrl=https://havenbackend-dev-8b95.up.railway.app` → routes the app's API calls
  to that backend and persists it to `localStorage['haven_api_base_url']`.
- `…?apiBaseUrl=default` → clears the stored override.

**Security gate (do not remove):** the override is honored **only when the build
is non-production** — i.e. `NEXT_PUBLIC_HAVEN_ENV` is a non-prod value (`dev`).
A production build ignores `?apiBaseUrl` entirely, so a crafted link cannot
redirect a logged-in user's `Authorization: Bearer <JWT>` to an attacker host
(#582). Implementation: `packages/frontend/src/lib/api.ts` (`getResolvedApiBaseUrl`).

**Consequence for QA:** the frontend you target must be a **dev/preview build**
with `NEXT_PUBLIC_HAVEN_ENV` set to a non-prod value, or `?apiBaseUrl` is a no-op.
The dev Vercel project sets `NEXT_PUBLIC_HAVEN_ENV=dev`; for PR-preview QA, the
Vercel **Preview** scope must set it too.

## QA identity, funding & secrets (owner-provisioned)

The QA layers run as a dedicated, seeded dev identity — never a real user. Set up
per #574; all values are **testnet/dev-only** and must differ from production.

- **Seeded identity:** a QA user + one Safe on Base Sepolia + a `QA Agent` with a
  small, reset-bound allowance, created idempotently against the dev backend by
  the seed script — `npm run seed -w packages/qa-agent` (#574 item 1; `SEED_*`
  env documented in [`packages/qa-agent/README.md`](../../packages/qa-agent/README.md)).
  The seed never holds the delegate key — it takes the delegate **address** only.
- **Funding (three wallets, distinct roles):** the delegate **signs** payments
  off-chain and never submits a transaction (`lib/allowance-module.ts`: *"the
  relayer pays gas; the delegate's signature authorises the transfer"*), so the
  delegate needs **no gas and no pre-funded USDC**. What actually needs funding on
  **Base Sepolia**:
  - **Safe** — test **USDC** (the spendable funds the allowance draws from), sized
    for many small runs.
  - **Relayer** (`RELAYER_PRIVATE_KEY`) — Base Sepolia **ETH** for gas; it submits
    the AllowanceModule transfers. Keep it topped up — a gas-empty relayer fails QA
    silently.
  - **Delegate** — nothing on-chain; just the key. Record its address for audit.
- **Secrets (names only — never commit values):** GitHub Actions secrets for the
  CI-driven layers — `QA_AGENT_API_KEY`, `QA_DELEGATE_PRIVATE_KEY`,
  `QA_HAVEN_API_URL` (= the dev backend), `QA_PAYMENT_TO`, plus any seeded-session
  token the live UI smoke needs. Local `.env` equivalents mirror
  [`.env.dev.example`](../../.env.dev.example).

## Safety (why this is safe to run often)

The dev environment is **testnet-only** (Gnosis Chiado / Base Sepolia), with an
isolated Postgres and a throwaway relayer/delegate holding only test funds. A
fully-compromised QA identity cannot move real money — QA leans on Haven's own
non-custodial invariant. No layer ever needs a production credential, a mainnet
RPC, or real funds.

## The layers (build order)

See epic #573. Build order: **#574 (foundation) → #575 (deterministic money-flow,
Node→API) → #576 (live UI smoke, browser) →** then the non-gating exploratory
layers (#577 LLM-agent, #579 browser exploration), with automation/gating last
(#578). Deterministic layers (#575/#576) are the promotion signal; the LLM layers
are non-gating coverage that file run reports under
[`bug-reports/`](../bug-reports/).

## Layer 2b — exploratory agent QA (`/qa-dev`, #577)

An LLM agent drives **natural-language payment goals** through the **real Haven
MCP** with the dev QA credentials, using the agent session's own model (no
`ANTHROPIC_API_KEY` in CI), and files a run report under
[`bug-reports/`](../bug-reports/). It exercises the live tool surface + runtime
wiring the deterministic harness (2a) can't. Because the tester is an LLM, it is
**never a deploy gate** — #575/#576 are the gate; 2b is exploratory.

- **When to run:** before a promotion, or after a risky change to the payment / MCP surface.
- **How findings feed back:** the report's *Friction* and *Notes for the coding agent* sections (and any issues it files) are the loop #419/#420 call for.
- **Claude Code:** run `/qa-dev` ([`.claude/commands/qa-dev.md`](../../.claude/commands/qa-dev.md)).

**Codex / generic runtime (pasteable prompt):**

> You are running exploratory QA against Haven's **dev** environment (testnet / Base
> Sepolia, capped QA delegate — never prod). Using the already-connected Haven MCP
> (or connect with `npx @haven_ai/connect@alpha --setup <QA setup token> --api <dev backend URL>`):
> 1. `haven_get_agent` + `haven_get_allowances` — confirm the dev QA agent and note the live remaining budget.
> 2. Pay the demo-merchant x402 call **within** budget (`haven_pay_x402`) → expect settlement + a receipt.
> 3. Attempt a payment **over** the remaining budget → expect it to queue for approval, not execute.
> 4. Make a priced call **above the max price** → expect a `PRICE_EXCEEDS_MAX` rejection.
> 5. `haven_list_receipts`, then `haven_verify_receipt` on the step-2 payment → expect it verifies.
> Stop at the first failed step. Then write a run report from
> `docs/bug-reports/_run-report-template.md` (per-goal pass/fail + friction) and file
> concrete bugs as issues. This is non-gating exploratory coverage.
