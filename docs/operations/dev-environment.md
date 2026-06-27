# Dev environment

Haven runs a single **shared dev environment** that mirrors production, so
work-in-progress on the `dev` integration branch can be exercised end-to-end
before it is promoted to `main`. There is one dev environment, not a per-PR
preview stack: **one `dev` branch → one set of Railway/Vercel deploys**.

This doc is the authoritative reference for how the dev environment is wired and
how to configure it. For the branch workflow that feeds it, see
[`../contributing/pr-workflow-checklist.md`](../contributing/pr-workflow-checklist.md).

## Topology

| Service | Platform | Deploys from | Notes |
|---|---|---|---|
| Frontend | **Vercel** (dev project) | `dev` branch | Bakes in `NEXT_PUBLIC_HAVEN_ENV=dev` at build time → shows the `DEV` badge. |
| Backend / API | **Railway** (dev project) | `dev` branch | Own isolated Postgres — never the prod DB. |
| Hosted MCP server | **Railway** (dev project) | `dev` branch | Points at the dev backend. |
| Demo-merchant | **Railway** (dev project) | `dev` branch | For x402 demo flows against dev. |
| Postgres | **Railway** managed | — | A separate managed instance, isolated from prod. |

Production is the same shape deploying from `main`. The two never share a
database, JWT secret, or relayer key.

**Live URLs** (no custom domain yet — we test against the platform URLs):

- Frontend (Vercel): **confirm the real URL in the Vercel dashboard** — `haven-dev.vercel.app`
  is a *different* app ("HAVEN Project" Vite SPA), not Haven's dashboard.
- Backend (Railway): `https://havenbackend-dev-8b95.up.railway.app` (`/health` is public).
  ⚠️ `dev-backend.up.railway.app` is a **stale duplicate** service (~24-day-old code) — do
  not use it; it caused real confusion (#585/#595).
- Demo-merchant (Railway): `https://demo-merchant-dev-84e4.up.railway.app` (`/healthz`).
- Hosted MCP (Railway): `haven-ai-hosted-mcp-dev-<hash>.up.railway.app` — confirm the hash.

## Branch → deploy mapping

- **`dev`** auto-deploys to the **dev environment** (this doc).
- **`main`** auto-deploys to **production**.
- Feature work flows `feature/* → dev → main`. The **`dev-gate`** workflow
  (`.github/workflows/dev-gate.yml`) only lets `dev` or `hotfix/*` merge into
  `main`, so the dev environment always reflects merged-and-green `dev`.

## Configuration

The template is [`.env.dev.example`](../../.env.dev.example) at the repo root. It
mirrors `.env.example` with dev-isolated values. Set these in the **dev Railway
project** (backend / mcp-server) and the **dev Vercel project** (frontend) —
never in code. **Every secret MUST differ from production.**

Isolation rules that are non-negotiable for a payments product:

- **Separate Postgres** from prod (`DATABASE_URL` points at the dev instance).
- **Dev-only `JWT_SECRET`** — prevents cross-environment token confusion.
- **Dev-only `RELAYER_PRIVATE_KEY`** — a throwaway EOA funded with minimal
  testnet gas, so WIP code can never move real funds.
- **Testnet RPCs by default** — `RPC_URL` → Gnosis **Chiado**, `RPC_URL_BASE` →
  **Base Sepolia**. Swap to mainnet RPCs only if a test genuinely needs mainnet
  state.

### The `DEV` badge

`NEXT_PUBLIC_HAVEN_ENV=dev` makes the frontend render a `DEV` chip in the app
`TopBar` (`components/EnvBadge.tsx`), in the warning tone, so a dev deploy is
never mistaken for production. `NEXT_PUBLIC_*` is build-time inlined, so the dev
Vercel deploy bakes the value in; **production leaves the var unset**, which
renders nothing.

## Inspecting the dev environment

- **Railway → dev backend service → Deployments** — build and runtime logs.
- **Railway → dev Postgres → Data** — inspect tables (read-only with Viewer role).
- **Vercel → dev project** — frontend build logs and the live frontend URL
  (confirm it in the dashboard; not `haven-dev.vercel.app`, which is a different app).
  The backend is `https://havenbackend-dev-8b95.up.railway.app`.

If you need an env var changed or a secret rotated in the dev projects, ping the
project owner — collaborators have Viewer access, not env-var write access.
