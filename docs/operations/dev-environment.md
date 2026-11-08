---
owner: "@d-hinders"
status: current
contract: true
covers:
  - scripts/ci/rpc-conformance.mjs
  - packages/backend/src/modules/catalog/merchant-catalog.ts
  - packages/backend/src/infra/repositories/merchants.ts
  - .github/workflows/dev-gate.yml
  - .github/workflows/qa-dev.yml
  - scripts/ci/qa-freshness.mjs
  - .env.dev.example
  - packages/frontend/src/components/ReceiveDialog.tsx
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
  - packages/frontend/src/lib/demo-gate.ts
  - packages/frontend/playwright.config.ts
  - packages/frontend/vercel.json
  - packages/frontend/src/lib/__tests__/vercel-ignore-build.test.ts
  - scripts/vercel/**
  - packages/backend/src/infra/chain/x402-binding-signer.ts
  - packages/backend/src/config/boolean-flag.ts
  - packages/frontend/package.json
  - .github/workflows/ci.yml
  - .github/workflows/update-visual-baselines.yml
last-verified: "2026-11-08"
---

# Dev environment

Haven runs a **shared dev backend stack** that mirrors production, so
work-in-progress on the `dev` integration branch can be exercised end-to-end
before it is promoted to `main`. The **backend, hosted MCP, demo-merchant, and
Postgres** are one shared set of Railway services deploying from `dev`. The
frontend's **canonical dev URL is the branch-tracking Vercel preview** of the
`dev` branch (a stable hostname that Vercel re-points at the newest `dev`
deployment); a PR gets its own preview link only when it opts in with a
`preview/<name>` branch ([below](#pr-previews-are-opt-in)). All of them
point at the same shared dev backend, so they are the same environment and the
same data — only the domain differs, which is what makes passkeys per-domain.

This doc is the authoritative reference for how the dev environment is wired and
how to configure it. For the branch workflow that feeds it, see
[`../contributing/pr-workflow-checklist.md`](../contributing/pr-workflow-checklist.md).

## Topology

| Service | Platform | Deploys from | Notes |
|---|---|---|---|
| Frontend | **Vercel** | `dev` branch alias + opt-in `preview/*` previews | Canonical dev URL: the **branch-tracking preview of `dev`** (stable hostname, serving the newest `dev` build — and a push that changes nothing the frontend is built from normally builds nothing; see [Which pushes rebuild the frontend](#which-pushes-rebuild-the-frontend)). Opt-in `preview/*` previews exist alongside it ([#3821](#pr-previews-are-opt-in)). There is no separate "dev" environment in Vercel — Haven's dev frontend **is** Vercel's **Preview** scope, which sets `NEXT_PUBLIC_HAVEN_ENV=dev` (→ `DEV` badge) and points the build at the dev backend. That is why every preview link is the same dev environment on a different domain. |
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

Each Railway service's start command, sleep setting and build source live in
Railway rather than the repo; they are recorded in
[`railway-services.md`](railway-services.md), with how to read the bill.

**URLs** (no custom domain — we test against the platform URLs):

- Frontend (Vercel): `https://haven-ai-frontend-git-dev-daniels-projects-f3327ba2.vercel.app`
  — the **branch-tracking preview of `dev`**: a stable hostname that Vercel
  re-points at the newest `dev` deployment without ever changing. Since #3594
  that deployment is of the newest `dev` commit *that changed the frontend's
  inputs*: a push that changes none of them normally skips its build
  ([below](#which-pushes-rebuild-the-frontend), including when it builds anyway). Verified 2026-08-06, before
  that change: it serves the same build as the immutable
  deployment of `dev` HEAD, and proxies to the dev backend. Preview links of
  opt-in `preview/*` branches exist alongside it and are what you use to test
  *that branch's build* — a different domain for each branch
  ([PR previews are opt-in](#pr-previews-are-opt-in)).
  **You will not find this URL under Vercel → Domains**, and that is expected:
  that page lists only *assigned* domains (production + custom). Branch aliases
  are generated automatically for any branch that has a deployment — open a
  `dev` deployment under **Deployments** and they are listed on the deployment
  itself. Vercel truncates the alias for long branch names, so copy it from
  there rather than hand-building it. The alias is **public** — no login gate —
  so treat the link as sharing the dev stack.
  **The consequence that bites:** **passkeys are bound to the exact domain they
  were created on**, so a passkey made on one preview is unreachable on the
  next (the browser offers only the "use another device" QR, which is
  domain-bound too and will not help). Keep passkey-holding accounts on the
  branch-tracking URL above, and to test previews without a new account per
  preview, enrol a wallet as a signer once and sign with it everywhere:
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
  The ops console's backend routes (`/ops/*`, #3509, epic #3507) answer 404
  on any backend that does not set all six `OPS_*` variables documented in
  [`.env.dev.example`](../../.env.dev.example); a partly-configured backend is
  the same as an unconfigured one. Setting them on a deployed service is an
  operator step tracked on the epic's promotion checklist. The data routes
  also need `OPS_DATABASE_URL`, the read-only role's login — see
  [`ops-readonly-role.md`](ops-readonly-role.md). The customer on-chain view
  (`GET /ops/users/{id}/onchain`, #3513) additionally needs the chain
  readers, which `index.ts` wires whenever the read-only role is configured;
  without them that one route answers 404 while the rest of `/ops` works.
  The system-health read (`GET /ops/health`, #3514) needs no extra
  configuration: it embeds the same payload the operator-token `/health/ops`
  serves (built by the same function, wired in `index.ts` whenever the
  read-only role is configured — without it this route answers 404 like the
  other data reads) plus monitor-derived problem lists. The delegate-balance
  section reflects the delegate monitor's last in-memory report, so a
  replica that does not hold the monitor's leader lock answers
  `not_available_on_this_replica` instead of figures; there is never a scan
  on request.
  ⚠️ `dev-backend.up.railway.app` is a **stale duplicate** service (~24-day-old code) — do
  not use it; it caused real confusion (#585/#595).
- Demo-merchant (Railway): `https://demo-merchant-dev-84e4.up.railway.app` (`/healthz`).
  The service sleeps (Railway serverless): the first call after idle cold-starts.
- Hosted MCP (Railway): `https://haven-ai-hosted-mcp-dev-25c7.up.railway.app/v1` —
  confirmed by probe 2026-08-06 (`GET /v1` → 405 POST-only MCP, `/healthz` → 200).
  Railway serverless sleep is on, but a steady client keeps it awake
  ([railway-services.md](railway-services.md#sleep)). If it does sleep, the first
  call after idle cold-starts.
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

### Which pushes rebuild the frontend

`packages/frontend/vercel.json` carries the frontend project's repo-expressible
Vercel settings (#3594): the framework, the install command, the build command
and the **Ignored Build Step**. Vercel reads it only because the project's
**Root Directory** is `packages/frontend`; leave the install command, build
command and Ignored Build Step unset in the dashboard, so the file is the one
source. The step runs the shared `scripts/vercel/ignore-build.sh` with the
watch file `scripts/vercel/watch/frontend.txt`, which lists the paths the
frontend is built from: `packages/frontend`, `packages/ui`, `packages/core`,
`tsconfig.base.json`, the root install inputs (`package.json`,
`package-lock.json`, `.nvmrc`) and the docs `next.config.ts` serves under
`/docs/` (the frontend's served-docs `ALLOWLIST`), minus three `!` exclude
globs (#3681): `packages/frontend/e2e/**` (Playwright specs and screenshot
baselines), `packages/**/__tests__/**` and `packages/**/*.test.*`. No source file
the build bundles statically imports one of those (the test checks it), so a change to them
alone deploys the same site; CI still runs and type-checks them on every push.
A build is skipped only
when none of them changed since the commit the project last **deployed**; the
rule and its edge cases are described once, in
[`ops-console.md` § Ignored Build Step](ops-console.md#1-the-vercel-project),
since the ops project runs the same script. For this project that means:

- A push that changes none of those paths (backend, SDK, CI, or a doc other
  than the served ones) shows `Vercel – haven-ai-frontend`: "Canceled by
  Ignored Build Step" and builds nothing (the deployment still counts toward
  the daily cap, below), provided the commit the project last
  deployed is in Vercel's clone; when it is not, the step builds. The `dev`
  host then keeps serving the last build, which is current, because nothing it
  serves changed.
- A `preview/*` branch's first preview compares the branch with its merge base
  with `dev`, fetching `dev` when Vercel's clone lacks it, so a frontend change
  gets a preview even when the newest push is docs-only. A `preview/*` branch
  that changes nothing the frontend is built from is skipped like any other
  push, so it gets no URL. If no merge base can be found, the
  preview builds, and the build log's `vercel ignore-build:` line names the
  step that failed. The first log after #3601 (PR #3622, 2026-10-05) found no
  merge base, without saying whether the fetch failed or found no shared
  commit, so the script now handles both. When `origin` is missing or its fetch
  fails, it uses the repository's public GitHub URL, built from
  `VERCEL_GIT_REPO_OWNER` and `VERCEL_GIT_REPO_SLUG`. When the shallow histories
  share no commit, it deepens the clone once. Whether a real first preview now
  skips is the operator check still open on #3594.
- A push to `dev` or `main` with no recorded previous deployment always builds.
- **A skipped build still counts toward the Hobby plan's cap of 100
  deployments a day** (#3681): the step saves build minutes and keeps the
  host current, not deployments. Each push to `dev`, `main` or a `preview/*`
  branch creates a frontend deployment, built or skipped; other branches create
  none (#3821). Unlike haven-ops, the frontend project has never recorded a
  "Skipped - Not affected" deployment ([below](#pr-previews-are-opt-in)), and
  the ops console deploys from `dev` only (see
  [`ops-console.md` § 1](ops-console.md#1-the-vercel-project)). When the cap is
  hit, Vercel refuses the deployment: its status reads "Resource is limited"
  (`api-deployments-free-per-day`), where a skip reads "Canceled by Ignored
  Build Step". The `dev` host keeps serving the last build, and the refused
  commit does not deploy by itself once the cap resets: it goes live with the
  next push, or through Deployments → Create Deployment.
- The list is checked against the real build inputs by
  `packages/frontend/src/lib/__tests__/vercel-ignore-build.test.ts`; a new
  workspace dependency, transpiled package or served doc that the list misses
  fails it.

**Rebuilding an unchanged commit.** A changed `NEXT_PUBLIC_*` value (Next
inlines them at build time) needs a rebuild that no git change triggers, so the
step would skip it. Set the project environment variable `FRONTEND_FORCE_BUILD`
to `1` in the scope you are changing (Preview for the dev host, Production for
production), redeploy the latest deployment of that branch, then delete
`FRONTEND_FORCE_BUILD`; left in place it makes every build in that scope run.

### PR previews are opt-in

Since #3821 the frontend project deploys only three kinds of branch
(`git.deploymentEnabled` in `packages/frontend/vercel.json`): `dev` (the dev
host), `main` (production) and `preview/*`. A push to any other branch, a
`feat/*` PR or a `hotfix/*` included, gets no frontend preview and no build —
and no "Skipped - Not affected" record either: the frontend project has never
recorded one. Those records belong to haven-ops, and they came from the
per-project Vercel setting **"Skip deployments when there are no changes to
the root directory or its dependencies"** — a dashboard setting under
Settings → Build and Deployment (Root Directory section) that `vercel.json`
cannot carry. The setting is believed off for the frontend, which has never
recorded a skipped deployment; nobody has checked its dashboard. On haven-ops the owner
found it **Enabled** and turned it off on 2026-10-15; its required value
there is **off**. Since then haven-ops has recorded no feature-branch
deployments (#3913's measurement); see
[`ops-console.md` § 1](ops-console.md#1-the-vercel-project).
#3821's Method counted 22–38
haven-ops deployments a day before #3681 took effect and 3 on 2026-10-08. No
required check reads a preview: browser smoke and visual regression run against
their own local server.

To get a preview of a branch, push it under a `preview/` name:

- open the PR from `preview/<name>` directly, so every push updates the
  preview; or
- push an existing branch there too (`git push origin HEAD:preview/<name>`),
  and push again to update it.

The preview still goes through the Ignored Build Step, so it gets a URL only
when the branch changes something the frontend is built from (above). Branches
cut before #3821 keep deploying until they pick up the new `vercel.json`,
because Vercel reads it from the commit it deploys.

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
  moved since 2026-06-26 (317 commits behind `dev` at the time),
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

**Boolean flags accept only lowercase `true` / `false` (#3015).** The
boolean flags `config.ts` reads at boot — `CATALOG_DISCOVERY_ENABLED`,
`HAVEN_FEE_ENABLED`, `HAVEN_LEGACY_BOOKKEEPING_ENABLED`, `HAVEN_HOSTED`,
`HAVEN_ACCOUNTING_ENABLED`, `HAVEN_OWNER_COMPANY_DETAILS`,
`HAVEN_MARKETPLACE_PROSPECTS` and the deprecated
`HAVEN_REPORTING_FEED_ENABLED` —
go through `parseBooleanFlag`: unset or blank means false; any other value
(`TRUE`, `1`, `yes`, `on`, a trailing space) **refuses the boot**, naming the
variable and the offending bytes. `HAVEN_HOSTED=TRUE` once reached production
and silently read as off. Precision: the deprecated alias is parsed only when
`HAVEN_ACCOUNTING_ENABLED` is unset (the new name shadows it), so a boot that
succeeds proves the seven active flags clean, not the alias. The Railway
audit (both projects, exact bytes) was completed 2026-09-15 and is
recorded on PR #3022. It covered the flags that existed then;
`HAVEN_MARKETPLACE_PROSPECTS` (#3078, 2026-09-17) and
`HAVEN_OWNER_COMPANY_DETAILS` (#3332) came later, and `X402_EMIT_PAYER_CONTEXT`
was not in that table either. `X402_EMIT_PAYER_CONTEXT` (#3021), read through
`parseBooleanFlag` in `packages/backend/src/infra/chain/x402-binding-signer.ts`, is the one exception to the
"only `true`/`false`" rule: it also accepts `1` (on) — the spelling every
#1690 document and template names — trimmed, with a one-line boot warning
that `true` is the preferred form. Anything else refuses the boot too. It is
read once at boot (a flip needs a restart) and logs a line when on.

Isolation rules that are non-negotiable for a payments product:

- **Separate Postgres** from prod (`DATABASE_URL` points at the dev instance).
- **Dev-only `JWT_SECRET`** — prevents cross-environment token confusion.
- **Dev-only `OPS_JWT_SECRET` and GitHub OAuth App** — the ops console (#3509) gets its own dev values, never the prod ones, for the same reason.
- **`RELAYER_PRIVATE_KEY`** — since the #908 owner decision (2026-07-19) the
  SAME relayer EOA (`0xC825…9D7E`) serves Base mainnet and Base Sepolia,
  funded on both; it is gas-only either way (customer funds are unreachable
  from it). It submits delegator activation, passport attestations and
  revocations, sweeps, and the outbound queue's fee bumps and lane cancels;
  agent payments are paymaster-sponsored UserOps and never use it (#3264). **Gnosis (chain 100) is intentionally unfunded/dead** — the
  delegation rail is pinned to 8453/84532, so a zero balance there is a
  decision, not a broken relayer.
- **`X402_BINDING_PRIVATE_KEY` is a dedicated key, and the backend refuses to
  boot if it is not** (#4655). It authenticates x402 expected context and sweep
  authorizations, and its address is published as `HAVEN_X402_BINDING_SIGNER`
  for installed signers to pin. A set value equal to `RELAYER_PRIVATE_KEY`, any
  `RELAYER_PRIVATE_KEY_<chainId>`, or `PASSPORT_RECEIPT_SIGNING_KEY` refuses the
  boot, naming the two variables and never the values; unset stays allowed. The
  comparison is on the key's value, so casing and the `0x` prefix do not hide a
  paste.
- **The bundler credential is per chain** (#3416). The delegation rail accepts
  both 8453 and 84532 on every deployment (`DELEGATION_RAIL_CHAIN_IDS` is a
  code constant), but a bundler URL is chain-scoped by its path. So
  `DELEGATION_RAIL_BUNDLER_URL_<chainId>` is read first for a chain, and the
  unsuffixed `DELEGATION_RAIL_BUNDLER_URL` is the fallback. What a chain with no
  usable credential answers is in
  [`delegation-rail-vendor-ops.md` §2](delegation-rail-vendor-ops.md). Every
  secret here still MUST differ from production.
- **Testnet RPCs by default** — `RPC_URL_BASE_SEPOLIA` → **Base Sepolia**
  (chain 84532, the chain dev's accounts and the money-flow harness use).
  `RPC_URL_BASE` always names a Base **mainnet** (8453) endpoint, on dev too:
  dev reads it every hour for the relayer balance monitor's 8453 entry (the
  same relayer key serves both chains) and for any other chain-8453 read.
  Unset, it falls back to the public mainnet node with a boot warning; a
  Sepolia URL there is a mismatch that reports a Sepolia balance as 8453.
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
  **Before either variable (or a `*_FALLBACK`) points at a new endpoint, run
  `node scripts/ci/rpc-conformance.mjs --url "$CANDIDATE_URL" --chain 84532`
  (#3336) — a required step.** Every line must be ✓: the chain id, a JSON-RPC batch of 10 (the harness's
  ethers providers batch up to 100 calls per ~10 ms), the `pending` block tag,
  `eth_getLogs` over the last 500 blocks (#4118), `eth_sendRawTransaction`
  accepted as a method (a zero-balance throwaway key, refused for funds, never
  mined) and a burst of 20 without a 429. dRPC's free
  plan (the dev primary 2026-09-24 → 2026-09-28) failed the batch and the
  `pending` tag; the shared public node can fail the burst — it is what a
  dedicated endpoint replaces. The probe measures per-second behaviour, never
  monthly quota: an endpoint that passes every line can still run out of
  compute units mid-month.

  The `eth_getLogs` line asks for 500 blocks because that is the widest batch
  the backend's settlement sweepers ask for (`EIP3009_LOG_BATCH_BLOCKS`,
  `SWEEP_LOG_BATCH_BLOCKS`; the probe's self-test pins it to them). Alchemy's
  free tier serves 10 blocks per call: the probe passed it 5/5 before this
  line existed, and then both sweepers were refused on every tick (#4012) and
  the QA observer graded real payments as missing (PR #4086). At 10 blocks the
  settlement sweep scans nothing on that chain
  ([accounting-feed.md](./accounting-feed.md)), so this line fails dev's
  primary while it stays on that plan — the step working, not a probe bug.
  The query is address-filtered and its result empty, so it measures the
  range cap only, not a result-count cap. A narrower `--logs-range` is for a
  variable whose reader asks for less, and it is justified in that variable's
  row of the table below. **The QA observer `QA_RPC_URL_BASE_SEPOLIA` is
  probed with `--logs-range 10`**: since PR #4086 the harness reads 10-block
  windows (`GET_LOGS_MAX_RANGE`), so 500 would measure nothing the observer does.

  ```sh
  node scripts/ci/rpc-conformance.mjs --url "$CANDIDATE_URL" --chain 84532 --logs-range 10   # QA_RPC_URL_BASE_SEPOLIA only
  ```

  **The dev arrangement since 2026-10-01 (#3489, #3456):**

  | Variable | Where | Provider | Burst of 20 | `--logs-range` |
  |---|---|---|---|---|
  | `RPC_URL_BASE_SEPOLIA` (primary) | `@haven/backend` / dev | Alchemy, the dev app | 20/20 answered, all 5 checks pass (2026-10-01, after the swap; probed before that day's key rotation, same app) | 500, the default (the sweepers' batch). Not yet probed with the `eth_getLogs` line; expected ✗ on the free tier's 10-block cap (#4118) |
  | `RPC_URL_BASE_SEPOLIA_FALLBACK` | `@haven/backend` / dev | Infura, free Core plan | **fails**: 20/20 then 14/20 rate-limited (2026-09-29), 20/20 (2026-09-30) | Informational, not a gate: no `eth_getLogs` reader uses the fallback (it carries the viem failover reads and the relayer's raw-send rebroadcast; the log scanners stay on the primary, see *RPC failover* below), so its logs line is covered by the fallback exception below. Re-probe at the default 500 only if it is ever promoted to primary |
  | `QA_RPC_URL_BASE_SEPOLIA` (the QA observer) | GitHub Actions secret | Alchemy, a separate QA-observer app | not probed | **10**: the harness reads 10-block windows (`GET_LOGS_MAX_RANGE`, PR #4086) and never asks for more |

  **Two owner-accepted exceptions to the probe rule above** (2026-10-01):
  - **The fallback fails the burst.** Infura's free plan is kept as a
    fallback only, never admitted as a primary
    ([#3489](https://github.com/d-hinders/Haven-AI/issues/3489)). It failed
    even after epic #3457 cut Haven's own usage, so the limit is the plan's
    per-second cap. Prod's `RPC_URL_BASE_FALLBACK` is the same Infura key and
    is presumed to fail the bar too; it was not probed separately
    ([#3456](https://github.com/d-hinders/Haven-AI/issues/3456)).
  - **The QA observer was not probed.** It moved to a new Alchemy app; the
    first money-flow run after the move passed 14/14 on attempt 1.

  Every Alchemy app draws on one account-wide monthly compute-unit allowance,
  prod's app included. An Alchemy burn-alert email reopens #3489.

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
  The same list scopes a merchant page's `funding` (#3331) — where the
  merchant is paid on each listed chain, the verified payTo a merchant-locked
  budget pins to. That needs every active offer on the chain to advertise
  ERC-7710, so the dev demo-merchant, which advertises EIP-3009 only until its
  ERC-7710 rail is enabled ([below](#enabling-the-erc-7710-rail-on-the-dev-demo-merchant)),
  reports `erc7710: false` and the build refuses a merchant-locked budget for
  it. The payTo itself arrives with the next catalog refresh after migration
 101 deploys (see `docs/product/marketplace.md`); until then every offer
 reads `unstated`.

  **The list, not the mode, names the enforced routes.** Since #3030 (epic
  #3028 slice 2) `index.ts` lists **every non-money route module** there —
  the four already-enforced ones (`contacts`, `merchants`, `labels`,
  `agent-labels`), the 22 slice-2 files (`accounting*`, `agent-activity`,
  `analytics*`, `auth`, `balances`, `catalog*`, `dashboard`, `discovery`,
  `health`, `openapi`, `passkeys`, `passport-verify`, `portfolio`,
  `safe-deploy`, `transactions`, `user`, `user-accounts*`, plus
  `accounting-webhooks`, which #3196 landed in the slice's base commit) and
  the bare `'index.ts'` for the inline `GET /` and `GET /chains`.
  `routes/x402.ts` joined them in slice 3 (#3031) — the first money-path
  module, and the only one the 2026-09-22 shadow reading proved conformant on
  every operation. The slice-3/4 modules stayed shadowed until then because
  the reading printed NOT PROVEN for 48 of their operations — 15 in slice 3's
  three remaining modules, 33 in slice 4's five — and the owner ruled (#3223,
  2026-09-24, on the epic) that routes a shadow reading can never prove are
  enforced on TEST evidence (per-route off-spec → envelope, conformant →
  unchanged), the same instrument decision 8 allowed slice 2. #3031 round 2
  flipped the rest of the money path (`routes/payments.ts`,
  `routes/agent-delegations.ts`, `routes/machine-payments.ts`) on those route
  tests plus the fresh #3208 shadow reading pasted on the epic (2026-09-26:
  28.46 h window, zero would_refuse and zero would_coerce). One money-path
  operation is the rollout's NAMED RESIDUE and stays SHADOWED by owner
  decision (epic #3028, 2026-09-24T21:24:44Z, closing #3223):
  `POST /machine-payments/reconciliation-events` — it is only posted on a
  genuine merchant rejection after a confirmed payment, and driving it
  synthetically would write a false record into a payment's ledger. It lives
  in its own file, `routes/machine-payments-reconciliation-events.ts`
  (registered under the same `/machine-payments` prefix), because
  enforcement is keyed on the route file and the plugin has no per-operation
  opt-out — a per-file exemption inside `machine-payments.ts` would have been
  invisible to the `lint:request-schemas` gauge. Its shadow residue is
  baselined (`shadow: 1, typeof: 5`), and it is enforced the day a real
  rejection (or a QA scenario that produces one) gives the shadow reading
  traffic to prove it. Slice 4 (#3032) added the last five (`agents`,
  `agent-rekey`, `agent-connection-setups`, `agent-passports`,
  `hybrid-accounts`) and flipped the default: every constrained module is
  listed and the mode defaults to `enforce`. Before the flip the list
  overrode every mode (the proof module had to refuse while the world was
  still in shadow); since the flip `off` and `shadow` are global — an entry
  in the list cannot escape either kill switch, which is what makes them
  switches.

  **Keyed on the FILE, not the mount prefix, since #3135** (epic #3028
  decision 7). A prefix could not express the epic's slice partition:
  `/agents` is shared by `agents.ts`, `agent-delegations.ts`, `agent-rekey.ts`
  and `agent-passports.ts`, which the epic splits across slices 3 and 4, and
  the root prefix `''` matched every module beneath it. The key is resolved
  per operation through the generated
  `packages/backend/src/openapi/route-modules.generated.ts`; regenerate it with
  `npm run generate:route-modules` after adding, moving or renaming a route
  (`npm run check:route-modules` and the backend suite both fail on a stale
  table). #4709's `POST /user/visits` and `GET /dashboard/since` are the latest
  rows: both live in modules already enforced (`routes/user.ts`,
  `routes/dashboard.ts`), so the table gained two rows and no module entered
  shadow. New modules are born ENFORCED with their own `enforcedModules`
  entry — #3164's `routes/agent-organizations.ts` (its own `/organizations`
  prefix) followed the #3167 precedent exactly, and #3329's two new modules
  did the same — the owner-auth `routes/agent-task-budgets.ts` (one GET under
  the `/agents` prefix) and the agent-auth, money-path
  `routes/task-budgets.ts` (its own `/task-budgets` prefix): a module with no
  installed caller has no old shape to shadow for, so it is enforced from its
  first commit even though it moves money. #3426's
  `routes/agent-tax-declaration.ts` followed the same rule — the GET (agent
  auth, one uuid path parameter, no body) and the PUT (owner auth) were both
  added to `enforcedModules` in their first commit; the request schema comes
  from the OpenAPI spec, so a body that is not exactly
  `{ tax_declaration_enabled: boolean }` is refused before the handler. #3509's
  `routes/ops.ts` did the same; its plugin answers 404 before validation
  when the ops console is unconfigured. #3512's data routes
  (`GET /ops/overview`, `/ops/search`, `/ops/users/{id}`) joined that module,
  so they were enforced from their first commit too. The
  `lint:request-schemas`
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
dev Railway backend. There is **no separate prod Fortnox app**: production
holds the same client id and secret as dev (compared by hash, 2026-10-29,
#4497), and they are inert there because `FORTNOX_REDIRECT_URI` is unset, so
Fortnox is not configured on prod. Whether prod keeps sharing the dev app or
registers its own is decided when Fortnox is enabled, under #2876. The feed
was live-proven against dev on 2026-07-16.

**Igdrasil** (#4518) is wired the same way: `IGDRASIL_CLIENT_ID`,
`IGDRASIL_CLIENT_SECRET` and `IGDRASIL_REDIRECT_URI` (the dev backend's
`/accounting/connections/igdrasil/callback`) register its connector at boot
only when all three are set. They are **not set on dev yet**: the app
registration with Igdrasil is pending, and the secret goes straight
into Railway when it arrives. The provider stays `coming_soon` until the live
check on dev (#4519), so setting the variables alone opens nothing.
[accounting-feed.md](./accounting-feed.md) is the reference.

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

### Enabling the Agent Passport check on the dev demo-merchant

The dev demo-merchant advertises **only `haven-demo`** by default. Since #4723
it can also advertise `haven-passport` and report the agent's passport standing
in its purchase response — advisory only, never a refusal. Like the ERC-7710
rail, this is a **manual variable change** on the Railway demo-merchant service;
the code deploys automatically and [`.env.dev.example`](../../.env.dev.example)
documents variables rather than applying them.

1. **Set both variables together** on the demo-merchant service:

   ```
   MERCHANT_HAVEN_BASE_URL=https://<dev backend public origin>
   MERCHANT_PASSPORT_ISSUER=<issuer from GET /passport/issuer on that backend>
   ```

   With either missing the merchant advertises only `haven-demo` and reports
   `passport: null` — exactly the pre-#4723 behaviour. A half-configured or
   invalid value logs a warning and disables the check rather than taking the
   merchant down.

2. **Read the issuer from the deployment you are pointing at**, not from a
   receipt: `curl -s "$API/passport/issuer" | jq -r .issuer`. It is the address
   of `PASSPORT_RECEIPT_SIGNING_KEY`, and it must be the DEV backend's — a prod
   issuer pinned on dev answers `not_signed_by_issuer` for every receipt. The
   dev verifier must be on first (`PASSPORT_RECEIPT_SIGNING_KEY` set; see
   [passport-verification-setup.md](passport-verification-setup.md)).

3. **Set them together, and not mid-quote.** The merchant's echo rule refuses a
   payment whose extensions do not contain every advertised key, so a 402
   quoted before the flip and paid after it is refused — and on the EIP-3009
   bridge that happens after funding, so the funds strand until a sweep. The
   window is one quote lifetime (`maxTimeoutSeconds`, 300 s).

4. **Rotating `PASSPORT_RECEIPT_SIGNING_KEY` breaks the pin.** The merchant
   answers `not_signed_by_issuer` for every receipt until
   `MERCHANT_PASSPORT_ISSUER` is updated; treat rotation as a breaking change
   ([secret-rotation.md](secret-rotation.md)).

To turn it back **off**, unset either variable. The merchant advertises only
`haven-demo` again, and a payment that still carries a reference reports
`passport: null` rather than a stale answer.

Reference: `packages/demo-merchant-mcp/README.md` § *Agent Passport check*.

### The `DEV` badge

`NEXT_PUBLIC_HAVEN_ENV=dev` makes the frontend render a `DEV` chip beside the
"Haven" wordmark in the sidebar's logo band (`components/EnvBadge.tsx`), in the
warning tone, so a dev deploy is never mistaken for production. (It lived in
the app `TopBar` until #4029 removed the bar. The 2px warning line #4029 added
along the top of the app was removed the next day: on a phone it read as a
rendering bug.) `NEXT_PUBLIC_*` is
build-time inlined, so the dev Vercel deploy bakes the value in; **production
leaves the var unset**, which renders nothing.

"Unset means production" is read in ONE place, `packages/frontend/src/lib/env.ts`
(#2709): the chip, the `?apiBaseUrl` override gate and the capability manifest's
`environment` field all read it there. The manifest used to read the raw variable
and answer `"unknown"` on production — the one deployment where an agent needs
the answer — so the convention this section describes is now the helper's
contract, not three separate interpretations of it: unset, empty, `production`
and `prod` are production; any other value is the deployment's own name.

### `HAVEN_DEMO_PAGE_VISIBLE` (#3477)

`/demo` and `/demo.md`'s production/testnet gate
(`packages/frontend/src/lib/demo-gate.ts`) has one override: the server-only
`HAVEN_DEMO_PAGE_VISIBLE` variable, read for the Playwright visual-regression
server, which otherwise builds like production (no `NEXT_PUBLIC_HAVEN_ENV`)
and would 404 the page it needs to screenshot. **Never set
`HAVEN_DEMO_PAGE_VISIBLE` in either Vercel project.** Nothing in the dev or
production Vercel env configuration sets it today, and `isDemoPageVisible`
additionally ignores the override whenever Vercel's own `VERCEL` variable is
present — belt-and-suspenders against it ever doing anything on a Vercel
deployment even if that changed.

A local `next dev` with no `.env` sets no environment name either, so it too
counts as production: to see `/demo` locally, start the server with
`HAVEN_DEMO_PAGE_VISIBLE=1`.

### `NEXT_PUBLIC_COINBASE_ONRAMP_APP_ID` in the Playwright builds (#3483)

The Receive dialog reads `NEXT_PUBLIC_COINBASE_ONRAMP_APP_ID` at build time
(`packages/frontend/src/components/ReceiveDialog.tsx`), so the app a visual
spec's server serves shows the "Buy with card" onramp card only when the BUILD
that produced it carried the id. Every CI surface that builds or serves the app
for Playwright therefore sets it: `ci.yml`'s frontend_checks build (whose
uploaded artifact the design_visual job downloads),
`update-visual-baselines.yml`'s build and both regenerate steps (under `CI=1`
the webServer boots that standalone build; the non-CI branch runs `next dev`,
which inlines the constant from `playwright.config.ts`'s `webServer.env`). All
of them set the same fixed synthetic literal, `e2e-onramp-app-id-placeholder`.
The frontend workspace's local equivalents of those gates set it too: the
`test:visual:structure` and `test:e2e:gate:built` scripts in
`packages/frontend/package.json` (#3487) build with the same literal.
**It is test-only by construction: nothing else in the repo sets the literal** —
no `.env*` file, no other workflow, no Docker or hosting config (the literal is
grep-unique, so the leak check is mechanical), and it is not a secret: the id
is never rendered, only its PRESENCE gates the card, so a fixed value keeps
renders deterministic across key rotations.

### The public site's former gate (#3573, removed by #3579)

From #3573 to #3579 the redesigned public site (epic #3572) was built in
slices behind a build-time gate that read `NEXT_PUBLIC_HAVEN_ENV` and a
`NEXT_PUBLIC_HAVEN_*` preview flag the CI builds set, so production kept the
legacy pages. The switch-over (#3579) deleted the gate with those pages: every
build renders the new site, the flag is read by nothing, and the CI builds and
Playwright no longer set it. A deployment that still sets the flag is
unaffected; deleting it from a project's settings is tidying, not a fix.

## Inspecting the dev environment

- **Railway → dev backend service → Deployments** — build and runtime logs.
- **Railway → dev Postgres → Database** — inspect tables. The service's tabs are Deployments, Database, Backups, Variables, Metrics, Console and Settings (owner screenshots of the dev and production projects, 2026-10-23). **Console** opens a shell on the service, where `psql` connects with an owner prompt (`railway=#`): run read-only queries only.
- **Vercel → dev project** — frontend build logs, the branch-tracking `dev`
  preview (the canonical dev URL above) and the opt-in `preview/*` deployments
  (open one only to test that branch's build — remember each is a
  different domain, so passkeys don't carry between them).
  ⚠️ `haven-dev.vercel.app` is a different app, not ours.
  The backend is `https://havenbackend-dev-8b95.up.railway.app`.

If you need an env var changed or a secret rotated in the dev projects, ping the
project owner — collaborators have Viewer access, not env-var write access.

Historical verification records for this document are kept in the [archive](../archive/re-verification-notes-2026-11.md).
