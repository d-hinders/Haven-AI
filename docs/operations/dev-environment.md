---
owner: "@d-hinders"
status: current
contract: true
covers:
  - .github/workflows/dev-gate.yml
  - .github/workflows/qa-dev.yml
  - .env.dev.example
  - packages/frontend/src/components/EnvBadge.tsx
last-verified: "2026-08-21" # #1670 re-verify: the backend gains TRUST_PROXY_HOPS (arms per-IP auth rate limits; hop COUNT, never `true` — see config.ts) — an OPERATOR env flip per environment, dev first. The .env.dev.example documents it, including the empirical hop-count verification step before trusting a new environment's proxy. Nothing else this doc claims moves; the dev wiring, endpoints and isolation rules re-read against the diff stand. Prior: #1459: the "no automated scenario covers the erc7710 rail" claim was false (x402-erc7710-settle has run nightly since #1064), and the QA-interaction note argued from a selector that #1453 changed — both corrected against the code as it now stands. #1154: the hosted MCP is now on the money-flow QA path (x402-hosted-mcp-signer), and qa-dev.yml gained a signer build step plus QA_HOSTED_MCP_URL / QA_X402_BINDING_SIGNER. Endpoints re-confirmed by a live run against dev the same day.
---

# Dev environment

Haven runs a **shared dev backend stack** that mirrors production, so
work-in-progress on the `dev` integration branch can be exercised end-to-end
before it is promoted to `main`. The **backend, hosted MCP, demo-merchant, and
Postgres** are one shared set of Railway services deploying from `dev`. The
frontend's **canonical dev URL is the branch-tracking Vercel preview** of the
`dev` branch (a stable hostname that Vercel re-points at the newest `dev`
deployment); each PR additionally gets its own per-PR preview link. All of them
point at the same shared dev backend, so they are the same environment and the
same data — only the domain differs, which is what makes passkeys per-domain.

This doc is the authoritative reference for how the dev environment is wired and
how to configure it. For the branch workflow that feeds it, see
[`../contributing/pr-workflow-checklist.md`](../contributing/pr-workflow-checklist.md).

## Topology

| Service | Platform | Deploys from | Notes |
|---|---|---|---|
| Frontend | **Vercel** | `dev` branch alias + per-PR previews | Canonical dev URL: the **branch-tracking preview of `dev`** (stable hostname, always the newest `dev` build). Per-PR previews exist alongside it. There is no separate "dev" environment in Vercel — Haven's dev frontend **is** Vercel's **Preview** scope, which sets `NEXT_PUBLIC_HAVEN_ENV=dev` (→ `DEV` badge) and points the build at the dev backend. That is why every preview link is the same dev environment on a different domain. |
| Backend / API | **Railway** (dev project) | `dev` branch | Own isolated Postgres — never the prod DB. |
| Hosted MCP server | **Railway** (dev project) | `dev` branch | Points at the dev backend via its own `HAVEN_API_URL`. ⚠️ Was found wired to `main` with a dead upstream on 2026-08-06 — [verify before trusting it](#verifying-a-dev-service-actually-works). |
| Demo-merchant | **Railway** (dev project) | `dev` branch | For x402 demo flows against dev. Advertises EIP-3009 first by default; the ERC-7710 rail is off unless enabled — see [below](#enabling-the-erc-7710-rail-on-the-dev-demo-merchant). |
| Postgres | **Railway** managed | — | A separate managed instance, isolated from prod. |

Production is the same shape deploying from `main`. The two never share a
database or JWT secret. The **relayer key is the deliberate exception**: one
EOA (`0xC825…9D7E`) is reused across Base mainnet and Base Sepolia and funded
on both (owner decision on #908, 2026-07-19) — the per-chain
`RELAYER_PRIVATE_KEY_<chainId>` mechanism *permits* split keys but is not
deployed that way today.

**URLs** (no custom domain — we test against the platform URLs):

- Frontend (Vercel): `https://haven-ai-frontend-git-dev-daniels-projects-f3327ba2.vercel.app`
  — the **branch-tracking preview of `dev`**: a stable hostname that Vercel
  re-points at the newest `dev` deployment, so it is always current without ever
  changing. Verified 2026-08-06: it serves the same build as the immutable
  deployment of `dev` HEAD, and proxies to the dev backend. Per-PR preview links
  exist alongside it (the PR's Vercel check) and are what you use to test *that
  PR's build* — they are a different domain each time.
  **You will not find this URL under Vercel → Domains**, and that is expected:
  that page lists only *assigned* domains (production + custom). Branch aliases
  are generated automatically for any branch that has a deployment — open a
  `dev` deployment under **Deployments** and they are listed on the deployment
  itself. Vercel truncates the alias for long branch names, so copy it from
  there rather than hand-building it. The alias is **public** — no login gate —
  so treat the link as sharing the dev stack.
  **The consequence that bites:** **passkeys are bound to the exact domain they
  were created on**, so a passkey made on one PR preview is unreachable on the
  next (the browser offers only the "use another device" QR, which is
  domain-bound too and will not help). Keep passkey-holding accounts on the
  branch-tracking URL above, and to test PR previews without a new account per
  PR, enrol a wallet as a signer once and sign with it everywhere:
  [`dev-testing-with-a-wallet-signer.md`](dev-testing-with-a-wallet-signer.md).
  Domain-hopping mid-flow has burned real sessions — finish on one link before
  moving to the next.
  ⚠️ `haven-ai-frontend.vercel.app` is the Vercel **production alias → PROD
  backend**: on it, dev-only features are missing and passkey onboarding dies
  with "Relayer is temporarily unfunded" (old code targets Gnosis, whose relayer
  is intentionally unfunded).
  ⚠️ `haven-ai-frontend-git-main-…vercel.app` is **not production**, despite
  Vercel listing it under the Production environment. It is the branch alias for
  `main`, and a branch alias tracks the newest deployment of that branch in *any*
  environment — a Jul 2026 redeploy landed as a Preview build, so this hostname
  serves the dev backend. Details and cleanup:
  [`promoting-dev-to-main.md`](promoting-dev-to-main.md) § *Run the prod smoke on
  the right hostname*.
  ⚠️ `haven-dev.vercel.app` is a *different* app
  ("HAVEN Project" Vite SPA), not Haven's dashboard.
- Backend (Railway): `https://havenbackend-dev-8b95.up.railway.app` (`/health` is public).
  ⚠️ `dev-backend.up.railway.app` is a **stale duplicate** service (~24-day-old code) — do
  not use it; it caused real confusion (#585/#595).
- Demo-merchant (Railway): `https://demo-merchant-dev-84e4.up.railway.app` (`/healthz`).
- Hosted MCP (Railway): `https://haven-ai-hosted-mcp-dev-25c7.up.railway.app/v1` —
  confirmed by probe 2026-08-06 (`GET /v1` → 405 POST-only MCP, `/healthz` → 200).
  The service sleeps (Railway serverless): the first call after idle cold-starts.
  Its `HAVEN_API_URL` must be `https://havenbackend-dev-8b95.up.railway.app` —
  it shipped pointing at a NONEXISTENT host (`havenbackend-dev-8a00`, the dev
  prefix with production's hash), which made every relayed call fail like a
  credential problem (#1131).
  ⚠️ That was one of **three** faults found on this one service in a single
  session — see [Verifying a dev service actually works](#verifying-a-dev-service-actually-works).
  Since #1154 this service is **on the money-flow QA path**: the
  `x402-hosted-mcp-signer` leg drives it over HTTP with a local edge signer, so
  a broken hosted MCP now turns `qa-dev` red instead of being discovered by
  hand. That leg reads the endpoint from `QA_HOSTED_MCP_URL` and the Haven
  binding-signer address from `QA_X402_BINDING_SIGNER` — both public values,
  set as repo variables (or secrets of the same name); missing either one skips
  the leg, which the blocking Coverage completeness step reports as a failure.
  See [`agent-qa.md`](agent-qa.md) § *The hosted-MCP leg*.

### Verifying a dev service actually works

"Deploys from `dev`" in the table above describes the intent, not a guarantee. On
2026-08-06 the dev hosted MCP was found with **two independent faults that had
persisted for weeks**, each invisible to every gate in the repo (#1131):

- its `HAVEN_API_URL` pointed at `havenbackend-dev-8a00.up.railway.app` — the `dev`
  prefix with **production's** hash — a host that does not exist, so Railway's edge
  answered `{"status":"error","code":404,"message":"Application not found"}` and every
  relayed call failed upstream;
- its Railway **Source** was connected to the **`main`** branch, not `dev`. So a service
  in the dev environment was serving *production* code — and because `main` had not
  moved since 2026-06-26 (317 commits behind `dev`; see the pending-promotion issue),
  auto-deploy had nothing to fire on and the build silently aged. Its commit predated
  SDK Base-Sepolia x402 support (`6d4d647`, 2026-06-28), so x402 payments failed with
  `No compatible payment option found in x402 requirements` — an error that reads like
  a merchant incompatibility, not a stale deploy.

None of this is visible from the repo: a branch setting and a hostname typo live only in
Railway, and a stale deployment still reports healthy. Before trusting a dev service,
check all three:

1. **It answers.** `curl -s https://<host>/healthz` → `{"status":"ok"}`.
2. **Its upstream resolves.** Read the service's `HAVEN_API_URL` in Railway and curl
   `<that host>/health`. `Application not found` means the hostname is wrong, not that
   the backend is down.
3. **Its build is current, from the right branch.** Railway → Settings → Source: a dev
   service must be connected to **`dev`**. Then compare the deployment's commit against
   `origin/dev` (`git log --oneline <deployed-sha>..origin/dev | wc -l`). A redeploy of
   an old commit looks identical to a fresh deploy in the Railway UI, and a service
   pinned to a branch that never moves never redeploys at all.

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
  treats a skipped leg as a FAILURE: since #1066 the repo variable
  `QA_REQUIRE_ALL_LEGS=1` is set and qa-dev's Coverage completeness step is
  blocking, so a run that skips any leg goes red and names it. Since #1063
  the delegation-rail QA identity is provisioned and forwarded to the
  harness — a reappearing skip means a broken precondition (drained QA
  treasury, expired credential, reverted env var), never a missing identity
  (see agent-qa.md, which also documents how to legitimately retire a leg).
  Since #1047 a `workflow_dispatch` override of `haven_api_url` is validated
  to be an `https://<app>.up.railway.app` origin (whole-string match) and
  logged with the dispatching actor — the quiet arbitrary-endpoint path is
  gone, though Railway itself is multi-tenant; the full residual-risk
  statement lives in autonomous-pr-loop.md's safety model.
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
- **`RELAYER_PRIVATE_KEY`** — since the #908 owner decision (2026-07-19) the
  SAME relayer EOA (`0xC825…9D7E`) serves Base mainnet and Base Sepolia,
  funded on both; it is gas-only either way (customer funds are unreachable
  from it). **Gnosis (chain 100) is intentionally unfunded/dead** — the
  delegation rail is pinned to 8453/84532, so a zero balance there is a
  decision, not a broken relayer.
- **Testnet RPCs by default** — `RPC_URL` → Gnosis **Chiado** (legacy config;
  chain 100 is dead per above), `RPC_URL_BASE` → **Base Sepolia**. Swap to
  mainnet RPCs only if a test genuinely needs mainnet state.
- **Served-chains gate** — `HAVEN_DEPLOY_CHAIN_IDS=84532` so dev only deploys
  accounts on Base Sepolia (onboarding offers only served chains, #679), and
  `NEXT_PUBLIC_HAVEN_CHAIN_ID=84532` so onboarding defaults there (#615). A
  multichain backend resolves the relayer **per chain**
  (`RELAYER_PRIVATE_KEY_<chainId>`, #640/#678) — a mechanism that *permits*
  isolating testnet from mainnet keys, though the deployed posture shares one
  key (see above).

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

1. **Set both variables together** on the demo-merchant service:

   ```
   MERCHANT_X402_SETTLEMENT_METHODS=eip3009,erc7710
   MERCHANT_ERC7710_DELEGATION_MANAGER=0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3
   ```

   If ERC-7710 is requested without the pinned manager address, the service
   starts EIP-3009-only and refuses explicit `settlement_method: "erc7710"`
   quotes. Hosted prod should not crash-loop because an optional ERC-7710
   variable is missing.

2. **The pinned DelegationManager must match the buyer side — use Haven's own
   pinned value.** For Base Sepolia that is
   `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3`
   (`packages/backend/src/rails/delegation-contracts.ts`, extracted from
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

4. **Mainnet is no longer structurally blocked.** PR #1266 retires the old
   #747 testnet-only guard now that #908 pinned the Base mainnet Delegation
   Framework contracts. Mainnet ERC-7710 still requires the canary discipline:
   use the exact pinned DelegationManager above, keep EIP-3009 first in
   `accepts[]`, confirm `extra.facilitatorAddresses`, and run a tiny-value
   end-to-end payment before treating it as ready for broader agent testing.

Existing variables (`MERCHANT_ADDRESS`, `BASE_RPC_URL`, `MERCHANT_CHAIN_ID`,
`MERCHANT_SKIP_SETTLE_PRODUCT`) need no changes.

To turn the rail back **off**, unset `MERCHANT_X402_SETTLEMENT_METHODS` when no
manager is configured, or set `MERCHANT_X402_SETTLEMENT_METHODS=eip3009`
explicitly. The manager variable can stay; without ERC-7710 in the effective
method list, the merchant advertises EIP-3009 only.

**An automated scenario covers this rail.** `x402-erc7710-settle`
(`packages/qa-agent/src/scenarios/x402-erc7710-settle.ts`, registered in
`run.ts`'s `SCENARIOS` since #1064) runs in the nightly money-flow QA and
settles a real 0.001 USDC treasury→merchant payment through the budget
delegation, asserting the delegate EOA is untouched. It **skips** — and under
the #1066 completeness gate that skip FAILS the run — when
`QA_DEMO_MERCHANT_URL` is unset or the merchant is not advertising erc7710,
which is the signal that this flag got turned off on dev.

`npm run pilot:x402-7710-buyer -w packages/qa-agent` remains the **manual**
tool for a one-off check against an arbitrary merchant (see its header for the
`PILOT_*` env it needs); it is not what proves the rail.

> **Interaction with QA (#946) — corrected after #1453/#1454.** This note used
> to say enabling the flag "cannot" move the `x402-delegation-3009*` scenarios
> onto erc7710 *because Haven's scheme selection never reads the merchant's
> `accepts` array*. That reasoning no longer holds, and the paragraph is kept
> rather than deleted because the old claim was load-bearing for how people
> reasoned about this flag.
>
> Selection **does** read the array now. `selectStandardPaymentOption`
> (#1453) skips erc7710-tagged entries instead of taking the first positional
> match, and `selectX402SettlementScheme` expresses the #1450 preference rule:
> prefer erc7710 on a delegation-rail account when the merchant advertises it,
> else the EIP-3009 bridge.
>
> The 3009 scenarios are still unaffected, for a **better** reason than before:
> `authorizeStandardX402` sends `payTo = the agent's delegate EOA` +
> `merchantPayTo = the merchant` with an explicit `settlementScheme: 'eip3009'`
> (#1360), and the backend dispatches on that shape (`routes/x402.ts`). Reaching
> erc7710 now takes a deliberate call — `HavenClient.settleX402Erc7710()`
> (#1454) — not an accident of array ordering.
>
> **The footgun that ordering was holding shut is gone.** Because the old
> selector ignored `assetTransferMethod`, a reordered `accepts[]` would have
> made a client echo the erc7710-tagged option while signing a standard
> EIP-3009 authorization; the merchant rejects that cleanly, but on the legacy
> two-leg the Safe→delegate funding transfer has already executed, so the
> visible result is a **stranded delegate balance** for the sweep. #1453 closed
> that class by construction. Keeping EIP-3009 at `accepts[0]` (pinned by
> `packages/demo-merchant-mcp/src/erc7710.test.ts`) still matters for a
> **generic** x402 client that infers the scheme from the first entry — it is
> no longer what protects Haven's own clients.

Reference: `packages/demo-merchant-mcp/README.md` § *ERC-7710 Smart-Account
Payments*.

### The `DEV` badge

`NEXT_PUBLIC_HAVEN_ENV=dev` makes the frontend render a `DEV` chip in the app
`TopBar` (`components/EnvBadge.tsx`), in the warning tone, so a dev deploy is
never mistaken for production. `NEXT_PUBLIC_*` is build-time inlined, so the dev
Vercel deploy bakes the value in; **production leaves the var unset**, which
renders nothing.

## Inspecting the dev environment

- **Railway → dev backend service → Deployments** — build and runtime logs.
- **Railway → dev Postgres → Data** — inspect tables (read-only with Viewer role).
- **Vercel → dev project** — frontend build logs, the branch-tracking `dev`
  preview (the canonical dev URL above) and the per-PR preview deployments
  (open a PR's own link only to test that PR's build — remember each is a
  different domain, so passkeys don't carry between them).
  ⚠️ `haven-dev.vercel.app` is a different app, not ours.
  The backend is `https://havenbackend-dev-8b95.up.railway.app`.

If you need an env var changed or a secret rotated in the dev projects, ping the
project owner — collaborators have Viewer access, not env-var write access.
