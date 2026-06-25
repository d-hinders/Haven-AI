# EPIC: Dev Environment — Branch-to-Dev Pipeline

> **Status:** Draft — awaiting review
> **Created:** 2026-06-23
> **Author:** Hermes (captain)
> **Related repo:** `https://github.com/d-hinders/Haven-AI`

---

## Problem

Currently, Haven deploys from `main` to production Railway. Feature branches are reviewed via PRs but never deployed to a live environment. Developers test locally with Docker Compose, which is fine for individual work but doesn't give an integrator the full-stack experience of hitting a real deploy with its own database, proper TLS, and all services wired together.

There is no intermediate environment between "local Docker" and "production."

## Goal

Every feature branch that touches code automatically deploys to a **dev environment** on Railway with its own isolated Postgres. The dev environment runs all three deployable services (frontend, backend, mcp-server) and is accessible via a URL for integration testing, stakeholder review, and QA before merging to production.

## Out of Scope (tracked separately)

- Staging environment (post-feature, pre-prod)
- E2E test suite that runs against dev URLs
- Load testing / performance benchmarking
- Demo-merchant MCP on dev (Phase 2)
- Multi-region deployment

---

## Current Production Setup

Already running on Railway (project: `Haven-AI`):

| Service | Cost/period | Notes |
|---|---|---|
| Backend | ~$0.75 | Dockerfile build |
| Hosted MCP | ~$0.50 | Dockerfile build, keyless |
| Demo-merchant | ~$0.44 | Nixpacks builder |
| Postgres | ~$0.42 | ~1.4 GB volume |
| **Total** | **~$2.11** | Fits within Hobby $5 credit |

Frontend is hosted on Vercel (separate from Railway).

## Architecture

**Dev is a mirror of prod.** Same 4 services, duplicated. Different branch, different env vars.

```
GitHub PR (feat/*, fix/*)
  → GitHub Actions: dev-deploy workflow
    → Railway API: deploy branch to dev services
    → Dev Postgres: auto-run migrations

Dev Environment (duplicate of Production)
├── Backend (Dockerfile: packages/backend/Dockerfile)
├── Hosted MCP (Dockerfile: packages/mcp-server/Dockerfile)
├── Demo-merchant (railway.json: Nixpacks)
├── Postgres (Railway managed, separate instance)
└── Frontend (Vercel project, separate from Prod)
```

### What changes vs Production

| Concern | Production | Dev | Rationale |
|---|---|---|---|
| Branch | `main` | Feature branches | Dev tests WIP code |
| Postgres | Existing | New instance | Payment product — never share DB |
| Relayer key | Prod EOA | Dev EOA (small xDAI) | Dev shouldn't spend real funds |
| JWT secret | Prod secret | Dev secret | Cross-env token confusion |
| RPC endpoints | Gnosis/Base mainnet | Same | On-chain is on-chain |
| WalletConnect | Prod project ID | Dev project ID | Separate analytics |
| Frontend | Vercel (prod project) | Vercel (dev project) | Separate deployments, env vars |
| Other env vars | Prod values | Dev values | Isolation |

### What stays the same

- Dockerfiles (`packages/backend/Dockerfile`, `packages/mcp-server/Dockerfile`)
- Nixpacks config (`packages/demo-merchant-mcp/railway.json`)
- Service structure (backend ↔ mcp-server ↔ postgres networking)
- Health check paths (`/health`, `/healthz`)
- Build/deploy configuration

**Setup is literally: duplicate each service in Railway, point to the dev branch, swap env vars.**

---

## Tasks

### Phase 1: Railway Project Setup

- [ ] **1.1** Create new Railway project: `Haven-AI Dev`
- [ ] **1.2** Add managed PostgreSQL to the dev project
- [ ] **1.3** Duplicate existing services into the dev project:
  - Backend → deploy from `packages/backend/Dockerfile`
  - Hosted MCP → deploy from `packages/mcp-server/Dockerfile`
  - Demo-merchant → deploy from `packages/demo-merchant-mcp/` (Nixpacks)
- [ ] **1.4** Configure inter-service networking:
  - mcp-server `HAVEN_API_URL` → internal backend URL (Railway internal hostname)
  - demo-merchant `HAVEN_API_URL` → internal backend URL
- [ ] **1.5** Set dev environment variables (see Phase 4)
- [ ] **1.6** Generate a dev relayer key (dev EOA), fund with minimal xDAI

### Phase 1B: Vercel Dev Project

- [ ] **1.7** Create new Vercel project (duplicate of prod Vercel project)
- [ ] **1.8** Configure Vercel dev project:
  - Root directory: `packages/frontend`
  - Framework preset: Next.js
  - Build command: `npm run build -w packages/frontend` (or mirror prod config)
  - Output directory: `.next`
- [ ] **1.9** Set dev environment variables on Vercel:
  - `NEXT_PUBLIC_API_URL` → dev backend public URL
  - `NEXT_PUBLIC_HAVEN_MCP_URL` → dev mcp-server public URL
  - `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` → dev WalletConnect project ID
  - `NEXT_TELEMETRY_DISABLED` → `1`
- [ ] **1.10** Add a dev badge/environment indicator in the frontend (e.g., "DEV" label in header)

### Phase 2: GitHub Actions — Dev Deploy Workflow

- [ ] **2.1** Create `.github/workflows/dev-deploy.yml`:
  - Trigger: PR open/sync for matching branches (`feat/*`, `fix/*`, `feature/*`)
  - Job 1: Run existing CI checks (reuse `ci.yml` logic)
  - Job 2: On CI pass, call Railway API to redeploy backend, mcp-server, demo-merchant from PR branch
  - Job 2b: Call Vercel API to deploy frontend from PR branch
  - Job 3: Run database migrations against dev Postgres (via backend migration scripts)
- [ ] **2.2** Add repo secrets:
  - `RAILWAY_TOKEN` (Railway API token with project write access)
  - `VERCEL_TOKEN` (Vercel team token)
  - `VERCEL_PROJECT_ID` (dev Vercel project ID)
- [ ] **2.3** Add PR comment on deploy: post dev URLs (backend, mcp, frontend) as a comment on the PR
- [ ] **2.4** Handle PR close/cancel: optionally spin down dev Railway services to save costs (Vercel preview deployments auto-expire)
- [ ] **2.5** Add manual trigger: `workflow_dispatch` for "redeploy current PR"
- [ ] **2.6** Configure Vercel deployment:
  - Use Vercel's native preview deployments (deploy each PR as a preview) OR
  - Use the `vercel` CLI in the workflow to push to the dev project (simpler, one shared dev URL)

### Phase 3: Database Migration Strategy

- [ ] **3.1** Audit existing migration files in `packages/backend/src/db/migrations/`
- [ ] **3.2** Ensure migrations are idempotent and auto-run on backend startup (or add a migration job)
- [ ] **3.3** Decide: should dev run all migrations on deploy, or have a separate migration service? (recommendation: auto-run on backend startup — matches current Docker Compose behavior)
- [ ] **3.4** Document dev DB reset procedure (for when dev schema gets corrupted)

### Phase 4: Environment Variable Management

- [ ] **4.1** Document all env vars needed per environment:
  - **Backend:** `DATABASE_URL`, `JWT_SECRET`, `PORT`, `FRONTEND_URL`, `LOG_LEVEL`, `GNOSIS_RPC_URL`, `BASE_RPC_URL`, `RELAYER_PRIVATE_KEY`, `ETHERSCAN_API_KEY`, `GNOSISSCAN_API_KEY`, `BASESCAN_API_KEY`, `COINGECKO_API_KEY`
  - **Frontend:** `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_HAVEN_MCP_URL`, `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`, `NEXT_TELEMETRY_DISABLED`
  - **MCP Server:** `PORT`, `HAVEN_API_URL`, `HAVEN_MCP_PATH`, `LOG_LEVEL`
- [ ] **4.2** Store dev env vars in Railway project variables (not in code)
- [ ] **4.3** Generate dev-specific secrets (JWT_SECRET, RELAYER_PRIVATE_KEY)
- [ ] **4.4** Consider: should we use a `.env.dev.example` file to track the full list? (Yes)

### Phase 5: Frontend Configuration

- [ ] **5.1** Audit `packages/frontend/next.config.mjs` — the `/api/*` rewrite uses `NEXT_PUBLIC_API_URL`
- [ ] **5.2** Verify rewrite works with dev Railway backend URL (not `localhost`)
- [ ] **5.3** Test that `NEXT_PUBLIC_HAVEN_MCP_URL` correctly points to the dev mcp-server
- [ ] **5.4** Add a dev environment indicator (e.g., "DEV" badge in header) that reads `NEXT_PUBLIC_HAVEN_ENV` env var
- [ ] **5.5** Configure `NEXT_PUBLIC_HAVEN_ENV=dev` on the Vercel dev project (empty on prod)

### Phase 6: Observability & Debugging

- [ ] **6.1** Configure dev health checks:
  - Backend: `GET /health`
  - MCP Server: `GET /healthz`
  - Frontend: (Next.js default)
- [ ] **6.2** Document how to tail dev logs from Railway
- [ ] **6.3** Add a dev environment indicator in the frontend (e.g., badge: "DEV" in header)

### Phase 7: Promotion Workflow

- [ ] **7.1** Document the flow: feature branch → dev deploy → QA → merge to main → production deploy
- [ ] **7.2** Decide: should production also auto-deploy on merge to main? (Currently appears manual or untracked — verify)
- [ ] **7.3** Consider: add a `dev-deploy` label that must be present for the workflow to trigger

---

## Dependencies

- Railway project access / team invites
- Railway token with project write access
- Dev relayer funded with xDAI on Gnosis Chain
- WalletConnect project ID for dev (or reuse prod — discuss)
- (Optional) Custom domain DNS for `dev.haven.ai`

## Risks

| Risk | Mitigation |
|---|---|
| Dev relayer key compromises | Key is in Railway env, not code. Dev EOA has minimal funds. |
| Dev DB contains sensitive data | Dev DB is isolated. Document a purge procedure. |
| Dev deploys get expensive | ~3 services per PR × many PRs = cost. Option: spin down on PR close, or limit to 1 active deploy per contributor. |
| Migration conflicts between dev/production | Separate DBs mitigate. Migrations should be forward-only and idempotent. |

## Cost Estimate (Railway)

Railway charges per-second usage (Hobby: $5 credit/mo, Pro: $20 credit/mo):

| Resource | Rate |
|---|---|
| Memory | $0.00000386 per GB/sec |
| CPU | $0.00000772 per vCPU/sec |
| Volume | $0.00000006 per GB/sec |

**One always-on dev stack (3 services + Postgres):**

| Service | ~Cost/mo |
|---|---|
| Backend (0.5 vCPU, 1 GB RAM) | ~$1.60 |
| Frontend (0.3 vCPU, 0.5 GB RAM) | ~$0.70 |
| MCP Server (0.2 vCPU, 0.5 GB RAM) | ~$0.55 |
| Postgres (0.5 vCPU, 1 GB RAM, 1GB vol) | ~$1.70 |
| **Subtotal** | **~$4.55** |

- **Hobby plan ($5 credit):** covers a single dev stack, minimal overage
- **Per active PR with independent services:** ~$3-5 extra each (3 services without Postgres)
- **Pro plan ($20 credit):** covers the base stack + 3-4 concurrent PR deploys
- Recommendation: start on Hobby, move to Pro if PR volume justifies it

## Success Criteria

- Opening a PR on a `feat/*` branch triggers CI → dev deploy within 5 minutes
- Dev URL is posted as a PR comment
- Dev frontend loads, shows a "DEV" indicator
- Backend `/health` returns 200
- MCP server `/healthz` returns 200
- Dev uses a separate Postgres from production
- PR close optionally cleans up the dev deploy

---

## Notes

- The existing Dockerfiles already do multi-stage builds for all 3 packages — they work for Railway directly.
- The demo-merchant-mcp already has a `railway.json` that shows the pattern (Nixpacks builder).
- Railway supports Dockerfile builds natively — we'll use the existing Dockerfiles rather than `railway.json`.
- The `NEXT_PUBLIC_API_URL` env var is used at build time in Next.js standalone mode — need to ensure it's set correctly for each deploy.
