# Agent QA — running the QA layers against the dev environment

The home doc for the automated, agent-based QA flow (epic #573). It lets a
contributor reproduce a QA run against the shared **dev environment**: which URLs
to target, how the backend override works, what credentials/funding are needed,
and how the layers connect. Companion to
[`dev-environment.md`](./dev-environment.md) (how the dev stack is wired).

> **Verify the stack first.** Do not start a QA run until the dev-stack
> verification checklist on #574 is fully green. The layers assume a correctly
> wired dev stack; today parts of it are unverified (CORS origin, `/api` proxy,
> demo-merchant on dev — see #585 and the #574 checklist).

## Targets

The dev **backend** stack has stable Railway URLs; the dev **frontend** has **no
permanent URL** — it is a per-PR Vercel preview link that changes on every
deployment. Pass the preview link in per run (e.g. as `PLAYWRIGHT_BASE_URL` / the
Layer 1 `base_url` input), and confirm the backend host in the Railway dev project.

| Surface | URL | Used by |
|---|---|---|
| Dev frontend | **Per-PR Vercel preview link** — changes each deploy, no permanent URL. Preview scope sets `NEXT_PUBLIC_HAVEN_ENV=dev`. | Layer 1 (#576), Layer 3 (#579) |
| Dev backend / API | `https://dev-backend.up.railway.app` | All layers (the stable API money flows hit) |
| Dev demo-merchant | _TBD — record once confirmed deployed on dev_ | Layer 2a (#575) x402 settlement |
| Dev MCP | _TBD — `.env.dev.example`'s `dev-mcp…/v1` returns 404; record the real one_ | Layer 2b (#577) |

## Two ways the layers reach the backend — they differ on CORS

This distinction decides what each layer depends on:

- **Node → API (server-to-server):** the seed script (#574) and the money-flow
  harness (#575) call the backend **directly** at
  `HAVEN_API_URL=https://dev-backend.up.railway.app`. No browser, **no CORS** — so
  these layers do **not** depend on the CORS fix (#585). Their blockers are the
  **demo-merchant on dev** and the **funded delegate / secrets**.
- **Browser (cross-origin):** the live UI smoke (#576) and browser-exploration
  (#579) drive a real browser against the **frontend** URL. To re-point a frontend
  at the shared dev backend they append `?apiBaseUrl=<dev-backend>` — a **browser
  cross-origin** call, so these layers **do** depend on the CORS fix (#585).

## The `?apiBaseUrl` override (gated — #582/#583)

A frontend can be re-pointed at a chosen backend at runtime:

- `…?apiBaseUrl=https://dev-backend.up.railway.app` → routes the app's API calls
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
  small, reset-bound allowance, created idempotently against the dev backend
  (seed script — #574 item 1).
- **Funded delegate:** the QA delegate EOA funded on **Base Sepolia** with test
  USDC + gas, sized for many small runs. Keep it topped up — a gas-empty delegate
  fails QA silently. Record the address so its balance can be monitored.
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
