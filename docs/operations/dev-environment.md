---
owner: "@d-hinders"
status: current
contract: true
covers:
  - .github/workflows/dev-gate.yml
  - .github/workflows/qa-dev.yml
  - .env.dev.example
  - packages/frontend/src/components/EnvBadge.tsx
  - packages/frontend/src/lib/env.ts
  - packages/backend/src/config.ts
  - packages/backend/src/modules/catalog/marketplace-scope.ts
  - packages/backend/src/routes/merchants.ts
  - packages/backend/src/openapi/request-validation.ts
  - scripts/ci/shadow-reading.mjs
  - packages/backend/src/routes/health.ts
  - packages/backend/src/openapi/route-modules.generated.ts
  - packages/backend/src/routes/agent-organizations.ts
  - packages/frontend/src/hooks/useOrganizations.ts
  - packages/backend/scripts/generate-route-modules.ts
  - packages/backend/src/index.ts
  - packages/backend/src/modules/accounting/api-key-flow.ts
  - packages/backend/src/routes/accounting-webhooks.ts
last-verified: "2026-09-25"
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
| Packages (`@haven_ai/sdk`, `signer`, `mcp`, `connect`, `cli`) | **npm** | `dev` branch → the **`dev`** dist-tag | A `0.0.0-dev.<ts>.<sha>` snapshot of all five on every package-touching push to `dev` (`publish.yml`, [#2421](https://github.com/d-hinders/Haven-AI/issues/2421)). Not a release: `alpha`/`latest` are the `main` channel and a snapshot can reach neither. The loop and the owner steps: [`package-dev-channel.md`](package-dev-channel.md). |

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
- Backend (Railway): `https://havenbackend-dev-8b95.up.railway.app` (`/health` is public and carries only status, timestamp, and database health; `/health/ops` is operator-only).
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
  **What actually keeps that run fresh is the nightly cron, alone, until a
  post-deploy run's `money-flow` job goes green at a promoted commit
  (#2268 → #2273).** `qa-dev.yml`'s
  old `repository_dispatch` (`dev-deployed`) trigger never fired once — nothing
  sent it, and Railway offers no supported place to send it from — so #2273
  replaced it with GitHub's own `deployment_status` event, fired when the
  Railway integration marks the `Haven AI / dev` deployment `success`, gated
  and de-duplicated in the workflow (evidence: agent-qa.md § *Post-deploy
  trigger (`deployment_status`)*). It was first observed firing on 2026-09-02
  (deployment 6218620498, `5d4e849c`; #2273 closed on it). #2404 (PR #2409)
  changed this gate to select the green run by SHA ancestry and by the
  `money-flow` job's conclusion instead of `--branch dev` — not because a
  post-deploy run has no branch (all three runs on that deployment report
  `headBranch = dev`, measured — #2427) but because a branch name says nothing
  about which commit the harness exercised. Until a post-deploy run is green
  at a promoted commit, a busy day's merges still outrun the cron and this
  gate blocks the promotion PR correctly but late, which is where the pressure
  to reach for `qa-override` comes from. The
  trigger's silence is reported by `guard-freshness.yml`, which since #2273
  counts only runs whose SHA Railway actually deployed — a manual dispatch
  cannot clear it (#2271).
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

**Boolean flags accept only lowercase `true` / `false` (#3015).** Every
boolean flag the backend reads at boot — `CATALOG_DISCOVERY_ENABLED`,
`HAVEN_FEE_ENABLED`, `HAVEN_LEGACY_BOOKKEEPING_ENABLED`, `HAVEN_HOSTED`,
`HAVEN_ACCOUNTING_ENABLED` and the deprecated `HAVEN_REPORTING_FEED_ENABLED` —
goes through `parseBooleanFlag`: unset or blank means false; any other value
(`TRUE`, `1`, `yes`, `on`, a trailing space) **refuses the boot**, naming the
variable and the offending bytes. `HAVEN_HOSTED=TRUE` once reached production
and silently read as off. Precision: the deprecated alias is parsed only when
`HAVEN_ACCOUNTING_ENABLED` is unset (the new name shadows it), so a boot that
succeeds proves the five active flags clean, not the alias. The Railway
audit of all six (both projects, exact bytes) was completed 2026-09-15 and is
recorded on PR #3022; `X402_EMIT_PAYER_CONTEXT` was not in that table and
needs its own reading before #3021 deploys. The seventh, `X402_EMIT_PAYER_CONTEXT` (#3021), is the one exception to the
"only `true`/`false`" rule: it also accepts `1` (on) — the spelling every
#1690 document and template names — trimmed, with a one-line boot warning
that `true` is the preferred form. Anything else refuses the boot too. It is
read once at boot (a flip needs a restart) and logs a line when on.

Isolation rules that are non-negotiable for a payments product:

- **Separate Postgres** from prod (`DATABASE_URL` points at the dev instance).
- **Dev-only `JWT_SECRET`** — prevents cross-environment token confusion.
- **`RELAYER_PRIVATE_KEY`** — since the #908 owner decision (2026-07-19) the
  SAME relayer EOA (`0xC825…9D7E`) serves Base mainnet and Base Sepolia,
  funded on both; it is gas-only either way (customer funds are unreachable
  from it). It submits delegator activation, passport attestations and
  revocations, sweeps, and the outbound queue's fee bumps and lane cancels;
  agent payments are paymaster-sponsored UserOps and never use it (#3264). **Gnosis (chain 100) is intentionally unfunded/dead** — the
  delegation rail is pinned to 8453/84532, so a zero balance there is a
  decision, not a broken relayer.
- **Testnet RPCs by default** — `RPC_URL` → Gnosis **Chiado** (legacy config;
  chain 100 is dead per above), `RPC_URL_BASE` → **Base Sepolia**. Swap to
  mainnet RPCs only if a test genuinely needs mainnet state.
- **Two Base Sepolia RPCs, and they must stay two** (#2511). The backend
  WRITES through `RPC_URL_BASE_SEPOLIA`; the QA harness OBSERVES through
  `QA_RPC_URL_BASE_SEPOLIA` (a GitHub Actions **secret**, since a provider URL
  embeds an API key). Both default to the shared public `https://sepolia.base.org`,
  whose rate limits arrive as `qa-dev` scenario failures rather than as Haven
  defects — that is what #2594 was. Point them at dedicated endpoints, but
  **not the same one**: an on-chain assertion verified on the node the backend
  wrote through proves only that the backend agrees with itself. The backend
  logs a boot warning when its variable is unset, and the harness prints which
  endpoint CLASS it is observing through (never the URL) in its run preamble.
- **RPC failover (#3255)** — the backend's viem clients (delegation-rail
  prepare, account deploy checks, caveat-enforcer and budget reads) fail over
  in order: `RPC_URL_BASE` / `RPC_URL_BASE_SEPOLIA`, then the optional
  `RPC_URL_BASE_FALLBACK` / `RPC_URL_BASE_SEPOLIA_FALLBACK` (a second provider
  account), then the public node. A transport failure (HTTP 429/5xx, a quota
  error in an HTTP 200 body, a timeout) moves to the next endpoint; an
  `eth_call` revert does not. Three things stay on `RPC_URL_BASE*` alone:
  the `disabledDelegations` heal read, because a lying node could fake a
  revoke; the relayer's ethers provider, because the signing wallet's nonce
  view must stay on one node (#1533); and the log scanners and settlement
  verifier behind that provider. The QA
  observer (`QA_RPC_URL_BASE_SEPOLIA`) is unaffected, and still needs its own
  endpoint, distinct from the backend's.

- **Marketplace chains and prospects (#3078, epic #3077)** —
  `HAVEN_MARKETPLACE_CHAIN_IDS=84532,8453` on dev (owner decision 11: the demo
  grid shows the real mainnet merchants next to the Ampersend sandbox; a
  mainnet offer is not payable from a Sepolia agent and its network chip says
  so) and `8453` on prod (testnets hidden outright). Unset falls back to
  `HAVEN_DEPLOY_CHAIN_IDS`, both unset lists every chain. The list scopes
  dashboard and credential-less reads only — an agent's `GET /catalog` sees
  its own chain regardless. `HAVEN_MARKETPLACE_PROSPECTS=true` (strict
  boolean) lists the `coming_soon` merchants of #3080 to authenticated
  dashboard users; it is set on dev standing (decision 14, 2026-09-20 — the
  prospects sit beside the mainnet merchants once the list is back on
  `84532,8453`, the operator step after PR #3202) and never on prod. The route
  lists them only when `HAVEN_MARKETPLACE_CHAIN_IDS` itself names a testnet,
  so a copied flag cannot publish them on prod, whose list is `8453`.
- **Served-chains gate** — `HAVEN_DEPLOY_CHAIN_IDS=84532` so dev only deploys
  accounts on Base Sepolia (onboarding offers only served chains, #679), and
  `NEXT_PUBLIC_HAVEN_CHAIN_ID=84532` so onboarding defaults there (#615). A
  multichain backend resolves the relayer **per chain**
  (`RELAYER_PRIVATE_KEY_<chainId>`, #640/#678) — a mechanism that *permits*
  isolating testnet from mainnet keys, though the deployed posture shares one
  key (see above).
- **Connector channel** — `HAVEN_CONNECTOR_CHANNEL` on the dev **backend**
  selects the npm dist-tag the dashboard's connector command hands out (#2422, epic
  #2420), and the same variable on the dev **hosted MCP** selects the tag its
  own "re-run the connector" hints name (#2423). Unset or empty means `alpha`;
  production leaves it unset, so the production handout is untouched by the
  variable's existence. The value must match `/^[a-z][a-z0-9-]{0,31}$/` — an
  invalid value makes the service refuse to start, naming the variable, rather
  than fall back to `alpha`, because a silent fallback would hand out the
  production connector from dev and look like it had worked. **This bullet
  describes the mechanism, not the deployed posture**: whether the dev services
  have it set is read from Railway, or from a fresh setup response's
  `connector_package` field (the package the backend actually used) — never
  assumed from prose. Setting it is owner-only and **ordered**: it must come
  *after* the `dev` dist-tag exists on npm for all five packages, or the
  dashboard hands out a tag `npx` cannot resolve (`ETARGET`; observed on
  2026-09-03 when it was set one step early — #2420 thread). The ordered
  checklist, and why the dev signer and dev backend must move together, are in
  [`package-dev-channel.md`](package-dev-channel.md) § *Operator checklist*.
- **Sweep recovery floor** — `SWEEP_MIN_USDC=0` in dev so the QA scenario's
  0.0005-USDC stranded balance exercises the real gasless recovery path. The
  production default is `0.01`; do not copy the dev override into production.
- **QA crash/resume grace** — set
  `MERCHANT_REPORT_GRACE_MIN_OVERRIDE=0` on the dev **backend only** before
  running the #2159 funded-but-undelivered QA leg. The backend starts only when
  this deployment serves exactly `HAVEN_DEPLOY_CHAIN_IDS=84532`; it rejects the
  override on mainnet, mixed, or unbounded deployments. Leave it unset outside
  that deterministic test so the normal 15-minute merchant-report grace stays
  in force; never set it in production.
- **Request-validation mode** — `HAVEN_REQUEST_VALIDATION` on the backend is
  `off` (no schema is injected — EXCEPT on an `enforcedModules` module,
  which stays enforced regardless of the mode) | `shadow` (default: log and
  count would-be refusals;
  since #3082 the request BODY is restored after validation so nothing the
  handler reads changes, and a body that coercion alone made valid is counted
  as `would_coerce`. Typed querystring/params are still coerced — that is what
  makes them usable) | `enforce` (off-spec requests get the documented 400
  envelope). Per the OpenAPI spec, via the request-validation plugin
  (#3029, epic #3028).

  **`enforce` is not global, despite the name.** A route is enforced only when
  the route FILE that declares it is in the plugin's `enforcedModules` —
  `mode` gates the `off` early-return and the counters and nothing else.
  Since #3030 (epic #3028 slice 2) `index.ts` lists **every non-money route
  module** there — the four already-enforced ones (`contacts`, `merchants`,
  `labels`, `agent-labels`), the 22 slice-2 files (`accounting*`,
  `agent-activity`, `analytics*`, `auth`, `balances`, `catalog*`,
  `dashboard`, `discovery`, `health`, `openapi`, `passkeys`,
  `passport-verify`, `portfolio`, `safe-deploy`, `transactions`, `user`,
  `user-accounts*`, plus `accounting-webhooks`, which #3196 landed in the
  slice's base commit) and the bare `'index.ts'` for the inline `GET /` and
  `GET /chains`. `routes/x402.ts` joined them in slice 3
  (#3031) — the first money-path module, and the only one the 2026-09-22
  shadow reading proved conformant on every operation. Eight money-path
  modules are still shadowed (`payments`, `machine-payments`, `agents`,
  `agent-delegations`, `agent-rekey`, `agent-passports`,
  `agent-connection-setups`, `hybrid-accounts` — the rest of slices 3–4,
  #3031/#3032). The reading printed NOT PROVEN for 48 of their operations —
  15 in slice 3's three remaining modules, 33 in slice 4's five — so on dev an off-spec request to any
  other route answers the 400 envelope. Slice 2 flipped on the epic's
  fallback (owner decision 2026-09-21 on #3028): the in-process shadow
  counter resets on every deploy and carried no per-route traffic (until
  #3208), so it could not prove the 22 modules; each module's route tests (off-spec → the
  envelope, conformant → unchanged) are the instrument, and `enforce` on
  dev is the reading. The variable is not the switch that widens the list.

  **Keyed on the FILE, not the mount prefix, since #3135** (epic #3028
  decision 7). A prefix could not express the epic's slice partition:
  `/agents` is shared by `agents.ts`, `agent-delegations.ts`, `agent-rekey.ts`
  and `agent-passports.ts`, which the epic splits across slices 3 and 4, and
  the root prefix `''` matched every module beneath it. The key is resolved
  per operation through the generated
  `packages/backend/src/openapi/route-modules.generated.ts`; regenerate it with
  `npm run generate:route-modules` after adding, moving or renaming a route
  (`npm run check:route-modules` and the backend suite both fail on a stale
  table). New modules are born ENFORCED with their own `enforcedModules`
  entry — #3164's `routes/agent-organizations.ts` (its own `/organizations`
  prefix) followed the #3167 precedent exactly, and #3329's two new modules
  did the same — the owner-auth `routes/agent-task-budgets.ts` (one GET under
  the `/agents` prefix) and the agent-auth, money-path
  `routes/task-budgets.ts` (its own `/task-budgets` prefix): a module with no
  installed caller has no old shape to shadow for, so it is enforced from its
  first commit even though it moves money. The `lint:request-schemas`
  gate keys its baseline entries with the
  same string, so the gate and the runtime agree about which modules are
  still shadowed — with one stated limit, closed in #3030: the gate reads a
  module's mount prefix from `index.ts`, and until #3030 it read only the
  `{ prefix: '…' }` shape, so a module registered bare
  (`app.register(fooRoutes)`, mounted at the root) was invisible to it and
  reported shadow 0 while the plugin ran it in shadow. `accounting-webhooks.ts`
  (#3196) was exactly that for a morning; the gate reads bare registrations
  as prefix `''` now.

  **How to take a shadow reading (#3208).** Not from `/health/ops` alone:
  its `request_validation` counters are in-process — they start at `since`
  (the plugin install) and dev redeploys on every merge, so the 2026-09-21
  reading covered five minutes and proved nothing (#3028 decision 8). The
  same events ride the log stream, which survives deploys: one line per
  would-refusal (`request_validation.would_refuse`), per coerced field
  (`would_coerce`) and, at most once per route per minute, the route's
  running traffic total (`request_validation.seen`). Aggregate a window of
  the backend's logs:

  ```bash
  railway logs --service '@haven/backend' --json --since 26h --filter "request_validation" --lines 5000 > rv.jsonl
  railway logs --service '@haven/backend' --json --lines 500 > anchor.jsonl
  cat rv.jsonl anchor.jsonl | node scripts/ci/shadow-reading.mjs --min-window-hours 24
  ```

  (`railway logs` reads the operator's own login; no token enters the repo.
  A saved file works too: `--file logs.jsonl`; `--module routes/x402.ts`
  limits the rows.)

  **The service is `@haven/backend` in environment `dev`** — quote it; `@` and
  `/` are shell-significant, and `railway status --json` lists the names. This
  runbook and #3208 both said `havenbackend-dev` until the first live reading
  (2026-09-22) met `Service 'havenbackend-dev' not found`; the script names no
  service, so it needed no correction. **Two fetches, because `railway logs` caps a page at 500 lines
  whatever `--since` says** (measured: `--since 1h` → 500, `--since 24h` →
  500), and this backend writes ~500 lines per two minutes, so one unfiltered
  fetch buys a two-minute window. The filtered fetch carries the data (`seen`
  is at most one line per route per minute, so 5000 rows reach well past a
  day); the unfiltered tail anchors the window's late edge. Anchor lines parse
  as `other` and widen the window only, never a count. `--since 26h` rather
  than `24h` leaves room for the cap to land the oldest row inside the day. The table has one row per SHADOWED operation — every
  operation in `route-modules.generated.ts`, not only the ones that logged —
  with `seen`, `would_refuse` and `would_coerce` by field, and a **verdict**:
  a route with `seen: 0` in the window is **NOT PROVEN** — the epic's rule
  that no traffic is no proof, printed rather than left to the reader; an
  enforced module's rows say "enforced" instead. The header states the
  window bounds (taken from every timestamped line, so a quiet day reads as
  a day), the line counts, the deploys, and the processes seen — traffic is
  summed per process (`hostname:pid`, so replicas add) from the `seen`
  line's running total; a process that started before the window is counted
  from its first line in it (the header says how many were cut). Two things
  the numbers under-state by design: a minute's last `seen` line is written
  on that minute's FIRST request, so the final minute of a process is
  under-counted by up to a minute's traffic; and a cut process with a single
  line counts as 1. Both err towards NOT PROVEN. If the header's `not ours`
  count equals the lines read (`lines.skipped` = `lines.read` under `--json`),
  that is **usually just a window with no validation lines in it** — the first
  2026-09-22 fetch read 500 traffic lines and none of ours, and
  `grep -c request_validation` on the raw file said 0. Check that before
  suspecting the envelope: Railway's `--json` hands the pino line FLATTENED
  (its fields lifted to the top level beside Railway's own `timestamp`), which
  `parseLine` reads correctly — proven by feeding two synthetic
  `request_validation` lines in that exact shape through with real traffic and
  watching their row appear. Only when a line you KNOW is present fails to
  appear is the envelope the problem; then save the raw lines and pass them
  with `--file`, or fix the one field name in `parseLine`. If it says `1 deploy(s)` on a day with merges, the CLI handed
  you the latest deployment's stream only — export the window from Railway's
  log explorer and pass it with `--file`. The minimum window is **24 hours**
  unless the epic's slice says more (#3028 decision 8); `--min-window-hours`
  prints the table and then exits 1 with a stderr note below that, so a
  narrower window cannot pass as a reading in a pipeline. Paste the table on
  #3028 — that is the operator step slices 3–4 (#3031, #3032) wait on.
  `/health/ops` still carries the live snapshot, now with `since` and
  `seenByRoute`, for a quick look between deploys.

  Any other value refuses the boot rather than falling
  back — a misspelled `enforce` must not silently mean `shadow`. **A mode
  change is a RESTART**: the injected schemas are fixed at route
  registration, so flipping the variable is a redeploy, not a live switch.

The dev backend also runs the **Fortnox bookkeeping integration**: `FORTNOX_*`
vars (client id/secret + redirect to the dev backend's
`/accounting/connections/fortnox/callback` — the provider-generic path since
#2862; the Fortnox app's registered redirect URI must match it) are set on the
dev Railway backend, using a **separate dev Fortnox app** — never the prod
credentials. The feed was live-proven against dev on 2026-07-16.

  > **Re-verified #3126 (2026-09-18):** round 3 of PR #3148 regenerated
  > `packages/backend/src/openapi/route-modules.generated.ts` — the branch
  > added `GET /machine-payments/balance-coverage` to
  > `routes/machine-payments.ts`, and #3138's generator tracks route files,
  > so the committed table was STALE against the registered routes (the
  > Backend-checks gate caught it on the PR). Regeneration ran
  > `npm run generate:route-modules` (deriving from `src/index.ts` +
  > `src/routes/*.ts` source) and adds exactly one row —
  > `"GET /machine-payments/balance-coverage": "routes/machine-payments.ts"`
  > — and `npm run check:route-modules` exits 0 at the new head. The plugin
  > resolves `enforcedModules` through this table, so the new route is
  > visible to request-validation in the same commit that registers it. The
  > generator script, `request-validation.ts`, `index.ts` and `config.ts`
  > claims above were re-read and are untouched by this PR.
  >
  > **Re-verified #3018 (2026-09-18):** the only `index.ts` change in PR
  > #3110 is the comment block above `registerConnector(new AccountedConnector())`
  > — it now describes the #3018 WORM document delivery (the receipt underlag
  > uploaded as one WORM document, delivery proven by sha256 echo) where it
  > previously said the connector's push half was still pending and skipped.
  > Comment-only: no registration, wiring or boot-order change. The doc's
  > other `index.ts` claims — boolean boot flags through `parseBooleanFlag`
  > and the request-validation `off`/`shadow`/`enforce` modes — were re-read
  > against the merged tree and hold; the doc makes no claim about
  > accounting-connector registration itself. Found stale here but
  > PRE-EXISTING and out of scope for #3018 (dev's own #3084 changed the code
  > without touching this doc): the enforced-module sentence in the
  > request-validation bullet above still named `['/contacts']` while
  > `index.ts` had moved on — flagged, not edited. Nothing in this file was
  > edited except this note and the `last-verified` date.
  >
  > **Resolved since:** #3111 corrected that sentence, and #3135 re-keyed the
  > option itself from `enforcedPrefixes` to the file-keyed `enforcedModules`.
  > The bullet above is current as of #3135.

  > **Re-verified #3018 (2026-09-18, round-3 follow-up):** the staleness
  > flagged in the blockquote above is fixed in this edit. The sentence now
  > names `['/contacts', '/merchants']` with the #3084 attribution and
  > re-derives the consequence: the refusal-set identity holds because an
  > enforced prefix refuses in every mode (`mode` gates only the `off`
  > early-return and the counters), and the widened enforcement is
  > non-vacuous — `/merchants/{slug}`'s required `slug` path parameter is
  > pattern-constrained in the spec. Re-read at dev tip ec41ee72 against
  > `packages/backend/src/index.ts` (the `installRequestValidation` options),
  > the plugin's `onRoute` wiring in
  > `packages/backend/src/openapi/request-validation.ts` (enforcement is
  > prefix-determined and mode-independent), the `/merchants` path items in
  > the OpenAPI spec, and the read-only GET registrations in the
  > `/merchants` route module.

  > **Re-verified #3019 (2026-09-20):** PR's `index.ts` change registers ONE
  > new plugin — `app.register(accountingWebhookRoutes)` — the Accounted
  > webhook receiver (`routes/accounting-webhooks.ts`, capability-URL token +
  > HMAC, its own encapsulated raw-body parser so the capture stays off every
  > other route). The doc's config claims are unaffected: the receiver reads
  > the existing `HAVEN_ACCOUNTING_ENABLED` flag (feature off → the route
  > still answers 200 with a counter — deliberate: a 4xx would eat the
  > provider's ~87 h retry budget) and adds no variable. The
  > request-validation claims hold unchanged: the webhook module is NOT in
  > `enforcedModules` (public route, spec-documented, carries no session
  > surface to shadow), and `route-modules.generated.ts` was regenerated in
  > the same commit (`npm run check:route-modules` green), including the
  > trailing-slash twin's spec entry so the provider never meets Fastify's
  > redirect. `HAVEN_SECRETS_KEY` now also protects the three webhook
  > signing secrets (same blob, same key) — the *Secrets at rest* section of
  > `docs/operations/accounting-feed.md` is the reference, not this file.

  > **Re-verified #3019 round 2 (PR #3196 review):** the webhook half now
  > requires `HAVEN_API_URL` (or `PUBLIC_API_URL`) on the BACKEND deployment.
  > The old `http://localhost:<port>` fallback is gone: with no stated origin
  > the connect flow refuses to register any subscription and flags the
  > connection `needs_attention` (`no public API origin configured`) instead
  > of writing a callback URL the provider could never reach. Dev backends
  > that exercise the webhook half must state the origin explicitly (the
  > Railway dev backend already does); a tunnel URL works, a loopback URL
  > does not — the provider refuses to dispatch to private/loopback addresses
  > by policy.

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

"Unset means production" is read in ONE place, `packages/frontend/src/lib/env.ts`
(#2709): the chip, the `?apiBaseUrl` override gate and the capability manifest's
`environment` field all read it there. The manifest used to read the raw variable
and answer `"unknown"` on production — the one deployment where an agent needs
the answer — so the convention this section describes is now the helper's
contract, not three separate interpretations of it: unset, empty, `production`
and `prod` are production; any other value is the deployment's own name.

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

> **Re-verified #3167 (2026-09-20):** this diff's two new route files
> (`routes/labels.ts`, `routes/agent-labels.ts`) are born ENFORCED —
> `enforcedModules` in `index.ts` grew by exactly those two entries, the
> generated map (`route-modules.generated.ts`) was regenerated in the same
> commit, and both modules carry spec request bodies the plugin can enforce.
> The shadow/enforce semantics this document describes are unchanged; the
> rollout moved in its own forward direction (new modules start enforced,
> shadow residue only shrinks — `lint:request-schemas` stays green with no
> baseline bump). Nothing else in this file's coverage was touched; the note
> and the `last-verified` date are the only edits.

> **Re-verified #3303 (2026-09-25):** `index.ts` registers one more pair of
> root hooks, `registerClientCompatHooks` (`middleware/client-compat.ts`), after
> the request-validation plugin. Its `preHandler` therefore runs after the
> plugin's `preHandler` has restored the client's body; it only reads the body
> (an idempotency key) and never mutates it, so the shadow-snapshot rule above
> holds. The `X-Haven-Client` header it reads is declared in the spec as an
> unconstrained optional string, so neither shadow nor enforce mode can refuse
> a malformed value. The shadow/enforce semantics, `enforcedModules` and the
> generated route-module table are unchanged (no route file added or moved).
> Nothing else in this file's coverage was touched; this note is the only edit.

> **Re-verified #3294 (2026-09-25):** `index.ts` gains two wiring lines and one
> sweep phase, none of them route work. The wiring: `setAnchorUidRepair` joins
> the other passport seams beside `setRevocationProbe` (it degrades to the
> pre-#3294 submit when unwired, so no boot path changes), and
> `repairAnchoredUids` is imported from the passport barrel. The phase: inside
> the existing leader-gated passport sweep, a `phase('anchor-repair', …)` runs
> BETWEEN the issuance retry phase and the revocation phase — a `limit`ed,
> `updated_at`-paced batch (`repairAnchoredUids()`), so a repair-triggered
> revoke shares the one relayer lane through the revocation sweep's ordinary
> backoff rather than stampeding it; phase isolation keeps its failure away
> from the safety-critical revocation half, as for issuance. No route file is
> added or moved, `enforcedModules` is untouched, and the shadow/enforce
> semantics this document describes are unchanged. Nothing else in this file's
> coverage was touched; this note and the `last-verified` date are the only
> edits.
