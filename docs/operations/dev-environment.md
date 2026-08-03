---
owner: "@d-hinders"
status: current
contract: true
covers:
  - .github/workflows/dev-gate.yml
  - .github/workflows/qa-dev.yml
  - .env.dev.example
  - packages/frontend/src/components/EnvBadge.tsx
last-verified: "2026-07-27"
---

# Dev environment

Haven runs a **shared dev backend stack** that mirrors production, so
work-in-progress on the `dev` integration branch can be exercised end-to-end
before it is promoted to `main`. The **backend, hosted MCP, demo-merchant, and
Postgres** are one shared set of Railway services deploying from `dev`. The
**frontend has no permanent dev URL** — it is served as **per-PR Vercel preview
deployments**, and the preview URL changes on every deployment.

This doc is the authoritative reference for how the dev environment is wired and
how to configure it. For the branch workflow that feeds it, see
[`../contributing/pr-workflow-checklist.md`](../contributing/pr-workflow-checklist.md).

## Topology

| Service | Platform | Deploys from | Notes |
|---|---|---|---|
| Frontend | **Vercel** (dev project) | per-PR preview deploys | **No permanent URL** — each PR gets a Vercel preview link that changes on every deployment. The Preview scope sets `NEXT_PUBLIC_HAVEN_ENV=dev` (→ `DEV` badge) and points the build at the dev backend. |
| Backend / API | **Railway** (dev project) | `dev` branch | Own isolated Postgres — never the prod DB. |
| Hosted MCP server | **Railway** (dev project) | `dev` branch | Points at the dev backend. |
| Demo-merchant | **Railway** (dev project) | `dev` branch | For x402 demo flows against dev. EIP-3009 by default; the experimental ERC-7710 rail is off unless enabled — see [below](#enabling-the-erc-7710-rail-on-the-dev-demo-merchant). |
| Postgres | **Railway** managed | — | A separate managed instance, isolated from prod. |

Production is the same shape deploying from `main`. The two never share a
database, JWT secret, or relayer key.

**URLs** (no custom domain — we test against the platform URLs):

- Frontend (Vercel): **no permanent URL** — it's a **per-PR Vercel preview link**
  that changes on every deploy (get it from the PR's Vercel check or the dev
  project's Deployments list). ⚠️ `haven-dev.vercel.app` is a *different* app
  ("HAVEN Project" Vite SPA), not Haven's dashboard.
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
  `main`, so the dev environment always reflects merged-and-green `dev`. It also
  carries the **money-flow QA freshness gate** (#578, hardened in
  [#1030](https://github.com/d-hinders/Haven-AI/issues/1030)): a promotion PR
  needs a green `qa-dev.yml` run on `dev` that is both recent **and actually
  covers the money-path code being promoted** — if a money-path file changed
  after the newest green run, the gate fails and names it. Since
  [#1044](https://github.com/d-hinders/Haven-AI/issues/1044) the gate also
  distinguishes green from green-with-SKIPS: when the covering run skipped a
  scenario leg (an unprovisioned optional identity), the promotion PR gets a
  warning that the certified coverage is partial — visible, not blocking,
  until the repo variable `QA_REQUIRE_ALL_LEGS=1` flips skips to failures.
  A **money-path `hotfix/*`** blocks outright: the harness tests a *deployed* backend and a
  hotfix is deployed nowhere until it merges, so no automatic evidence about it
  can exist. Bypass in both cases: the `qa-override` label, with a comment
  stating what was verified. Both `gate` and `qa-freshness` are **required
  status checks on `main`** as of 2026-07-27.

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
- **Served-chains gate** — `HAVEN_DEPLOY_CHAIN_IDS=84532` so dev only deploys
  accounts on Base Sepolia (onboarding offers only served chains, #679), and
  `NEXT_PUBLIC_HAVEN_CHAIN_ID=84532` so onboarding defaults there (#615). A
  multichain backend resolves the relayer **per chain**
  (`RELAYER_PRIVATE_KEY_<chainId>`, #640/#678), so a testnet relayer can never
  touch mainnet funds.

The dev backend also runs the **Fortnox bookkeeping integration**: `FORTNOX_*`
vars (client id/secret + redirect to the dev backend's
`/accounting/fortnox/callback`) are set on the dev Railway backend, using a
**separate dev Fortnox app** — never the prod credentials. The feed was
live-proven against dev on 2026-07-16.

### Enabling the ERC-7710 rail on the dev demo-merchant

The dev demo-merchant advertises **EIP-3009 only** by default. The experimental
ERC-7710 rail (#747, epic #452) lets a smart account pay the merchant *directly*
from a signed delegation, with no funding leg — useful when exercising the
delegation rail's erc7710 settlement rather than the #946 EIP-3009 bridge.

**Code deploys automatically; variables do not.** PR #750's code is already live
on the service, and [`.env.dev.example`](../../.env.dev.example) documents the
service's variables rather than applying them. Turning the rail on is a manual
variable change on the Railway demo-merchant service.

1. **Set both variables together**, on the **dev** demo-merchant service only:

   ```
   MERCHANT_X402_ERC7710=1
   MERCHANT_ERC7710_DELEGATION_MANAGER=0x…
   ```

   The flag without a valid manager address makes the service **exit at
   startup by design** — on Railway that is a crash-loop until the second
   variable lands. Expect it if you set them one at a time.

2. **The pinned DelegationManager must match the buyer side — use Haven's own
   pinned value.** For Base Sepolia that is
   `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3`
   (`packages/backend/src/lib/delegation-contracts.ts`, extracted from
   `@metamask/smart-accounts-kit` **1.6.0**). Haven's delegation-rail agents —
   the accounts this feature exists to let pay this merchant — always sign
   against that address.

   Do **not** substitute whatever is currently top of MetaMask's published
   deployments list: the address is **version-specific**, a kit upgrade can move
   it, and a mismatch fails *every* real Haven-agent payment to this merchant
   with `Payment delegationManager is not the delegation manager trusted by this
   merchant`. The payload's `delegationManager` is attacker-supplied, so
   delegations naming any other contract are rejected before simulation — which
   is the intended behaviour, and also exactly what a wrong pin looks like.

3. **No new keys.** The service's existing Sepolia-funded
   `SETTLEMENT_PRIVATE_KEY` account doubles as the **redeemer** that submits
   `redeemDelegations`. A delegation carrying a redeemer caveat must name that
   address.

4. **Testnet-only, structurally.** Startup refuses the flag on any chain other
   than `MERCHANT_CHAIN_ID=84532`, so mainnet can never advertise erc7710. Do
   **not** add these variables to the production merchant service — a mistaken
   flag there fails loudly at startup rather than enabling the rail.

Existing variables (`MERCHANT_ADDRESS`, `BASE_RPC_URL`, `MERCHANT_CHAIN_ID`,
`MERCHANT_SKIP_SETTLE_PRODUCT`) need no changes.

To turn the rail back **off**, unset `MERCHANT_X402_ERC7710` alone; the manager
variable can stay. The flag is the only thing consulted when building the
processor options, so the merchant reverts to advertising EIP-3009 only.

To confirm it actually redeems end-to-end, the repo's one tool for this is the
manual pilot buyer:
`npm run pilot:x402-7710-buyer -w packages/qa-agent` (see its header for the
`PILOT_*` env it needs). No automated scenario covers the erc7710 rail.

> **Interaction with QA (#946) — it is safe, but not for the reason you might
> expect.** Enabling this flag **cannot** move the `x402-delegation-3009*`
> scenarios onto erc7710, because Haven's scheme selection never reads the
> merchant's `accepts` array. `authorizeStandardX402` sends
> `payTo = the agent's delegate EOA` + `merchantPayTo = the merchant`
> unconditionally (`packages/sdk/src/client.ts`), and the backend dispatches on
> that **payTo shape alone** (`routes/x402.ts`) — a point its own test pins with
> *"the erc7710 selector was never consulted."*
>
> The merchant's ordering (EIP-3009 stays `accepts[0]`, pinned by
> `packages/demo-merchant-mcp/src/erc7710.test.ts`) matters for a **generic**
> x402 client that infers the scheme from the first entry — the SDK's
> `selectStandardPaymentOption` takes the first match on
> scheme/network/asset/amount and never inspects `assetTransferMethod`. If that
> array were reordered, such a client would echo the erc7710-tagged option while
> still signing a standard EIP-3009 authorization, and the merchant would reject
> it cleanly with `Invalid erc7710 payment field: delegator must be an address`
> — before any simulation or settlement. On the legacy two-leg path the
> Safe→delegate funding leg has already executed by then, so the visible
> consequence is a **stranded delegate balance** for the sweep to reclaim, not a
> mis-signed payment.

Reference: `packages/demo-merchant-mcp/README.md` § *Experimental: ERC-7710
smart-account payments (testnet-only)*.

### The `DEV` badge

`NEXT_PUBLIC_HAVEN_ENV=dev` makes the frontend render a `DEV` chip in the app
`TopBar` (`components/EnvBadge.tsx`), in the warning tone, so a dev deploy is
never mistaken for production. `NEXT_PUBLIC_*` is build-time inlined, so the dev
Vercel deploy bakes the value in; **production leaves the var unset**, which
renders nothing.

## Inspecting the dev environment

- **Railway → dev backend service → Deployments** — build and runtime logs.
- **Railway → dev Postgres → Data** — inspect tables (read-only with Viewer role).
- **Vercel → dev project** — frontend build logs and the **per-PR preview
  deployments** (no permanent dev frontend URL; open the preview link for the
  deployment under test). ⚠️ `haven-dev.vercel.app` is a different app, not ours.
  The backend is `https://havenbackend-dev-8b95.up.railway.app`.

If you need an env var changed or a secret rotated in the dev projects, ping the
project owner — collaborators have Viewer access, not env-var write access.
