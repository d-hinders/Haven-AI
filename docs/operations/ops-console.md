---
owner: "@d-hinders"
status: current
covers:
  - packages/ops/**
  - scripts/vercel/**
  - packages/frontend/vercel.json
  - packages/backend/src/routes/ops.ts
  - packages/backend/src/modules/ops/**
  - packages/backend/src/middleware/ops-auth.ts
  - packages/backend/src/db/ops-read-pool.ts
  - packages/backend/src/infra/ops-readonly-role.ts
  - packages/backend/src/infra/repositories/ops-access-log.ts
  - packages/backend/src/config/ops.ts
  - packages/backend/scripts/ops-readonly-role.ts
last-verified: "2026-10-06"
---

> **Re-verified #3821 (2026-10-09):** only the Ignored Build Step paragraph
> changed — the frontend project takes the first-preview path for opt-in
> `preview/*` branches only. Nothing else in this document was re-verified,
> and `last-verified` is not bumped.

# Ops console

The private operations console (`@haven/ops`, epic #3507): a founders-only,
read-only window onto a Haven backend. This page is the operator runbook —
how to deploy the console as its own Vercel project, wire a backend to it,
and run it day to day. What the routes return is the backend's story
(`packages/backend/src/routes/ops.ts`); the read-only role has its own
runbook, [`ops-readonly-role.md`](ops-readonly-role.md). Part of the deploy
slice is recorded here rather than in `vercel.json`, because Vercel cannot
read those settings from the repo — every one of them is in
[the operator checklist](#per-environment-operator-setup) below.

## What the console is — and is not

**It is:**

- a read-only surface: platform overview, the last 7 days of customer
  feedback (#3602), customer search, one customer's record, the chain's view
  beside the database's, system health, and a reveal of the few allowlisted
  fields the backend permits;
- audited end to end: every sign-in that reaches a GitHub identity (allowed
  or refused), every data read and every reveal writes one `ops_access_log`
  row through the backend's MAIN pool before the response is sent — a write
  that fails refuses the request;
- origin-isolated: a session token is stored per backend origin and attached
  only to that origin, so a prod token can never reach the dev backend and
  vice versa.

**It is not:**

- spend authority. Nothing under `/ops` moves funds, signs, changes signers
  or delegations, or acts as a user — the backend pins that invariant in its
  ops tests, and the console's own source guard pins storage and import
  rules;
- a second way in. It authenticates with a bearer token minted by the
  backend's GitHub sign-in — never a cookie, never the dashboard's JWT —
  and the backend re-checks the GitHub id against the CURRENT allowlist on
  every request;
- public. Search engines get `noindex`, framing is refused, and the app
  ships an enforcing CSP whose `connect-src` is `'self'` plus exactly the
  registry origins this deployment offers. Its scripts are gated on a per-request nonce that
  `packages/ops/src/middleware.ts` sets (#3581); a blank page with
  `Refused to execute inline script` in the browser console means that
  nonce is not reaching Next's scripts. CI's render smoke (#3583) loads the
  production build in Chromium to catch this before merge.

## Sign-in and the environment switcher

One button: **Sign in with GitHub**. The handoff is the backend's GitHub
OAuth flow with no scopes — GitHub is used to prove identity, nothing more:

1. The app redirects to the selected backend's
   `GET /ops/auth/github/start?return_to=<console origin>&nonce=<n>`.
2. The backend sends the browser to GitHub with a signed, 10-minute state.
3. The callback verifies state and origin, exchanges the code, reads
   `GET /user`, drops GitHub's token, checks the numeric GitHub id against
   the allowlist (and that 2FA is enabled), writes the audit row, and
   redirects to `<console origin>/#token=<ops token>&nonce=<n>` — or
   `#error=<code>&nonce=<n>`.

A session token lives 8 hours (`OPS_TOKEN_TTL_MS`), is verified per request
against the allowlist, and dies the moment the origin's storage drops it
(a 401 from the backend clears it in the app). Sign-in errors surface as
messages: `not_allowed`, `two_factor_required`, `github_denied`,
`github_unavailable`.

The **environment switcher** offers exactly the backends in the registry —
`NEXT_PUBLIC_OPS_ENVIRONMENTS`, JSON such as `{"dev":"https://…"}`. Keys are
labels; the key `prod` is production and turns on the red banner on every
page ("You are working in production. Every read you make is audited.").
An environment absent from the registry is not offered; a registry that
offers nothing is a config error the console shows instead of quietly
running against nothing.

## Per-environment operator setup

One console deployment per Haven environment, in this order. Steps 1, 2 and
the Vercel-side halves are dashboard settings Vercel cannot read from the
repo — record what you actually entered on the issue when you do them.

### 1. The Vercel project

1. Vercel → Add New → Project → import `d-hinders/Haven-AI`.
2. Set **Root Directory** to `packages/ops`.
3. Set **Production Branch** to `dev` — owner decision, 2026-10-01. This
   departs from the frontend precedent (`dev-environment.md`, where `main`
   is production and dev is a truncated `…-git-dev-…` alias). It is safe
   here because the app picks its backend at runtime from the registry, so
   the build branch does not decide which data it shows; and it buys a
   short, stable **production domain** that always serves the latest `dev`
   build.
4. Turn **Include files outside the root directory** ON. The build reads the
   repo outside `packages/ops` — the #3511 doc-health generator walks
   `docs/` and `scripts/` — and without this Vercel uploads the package
   alone.
5. Leave install/build/headers alone: `packages/ops/vercel.json` already
   carries the repo-expressible settings (install command, build command,
   the Ignored Build Step, HSTS). A dashboard override of a setting the file
   sets is a second source of truth that will drift.
6. Create the project and note the **production domain** Vercel assigns
   (`haven-ops.vercel.app` if the name is free, otherwise a suffixed or
   added `*.vercel.app` domain). Steps 3 and 5 need that exact origin.

**Deploys from `dev` only (#3681).** `packages/ops/vercel.json` sets
`git.deploymentEnabled` to `{ "**": false, "dev": true }`: a push to any other
branch creates no console deployment at all. Vercel deploys a branch when any
`true` rule matches it, so `dev` matches and nothing else does. Previews could
never sign in (below), and every push used to spend one deployment of the
Hobby plan's 100-a-day cap on this project even when the Ignored Build Step
skipped it, because a skipped deployment still counts toward the cap. To
review a console change before merge, run it locally
(`npm run dev -w @haven/ops`).

**Ignored Build Step.** `packages/ops/vercel.json` runs the shared
`scripts/vercel/ignore-build.sh` (#3594), passing it `OPS_FORCE_BUILD` and
the watch file `scripts/vercel/watch/ops.txt`, which lists the paths the
console is built from: `packages/ops`, `packages/ui`, `packages/core`,
`scripts/docs`, `tsconfig.base.json` and the root install inputs
(`package.json`, `package-lock.json`, `.nvmrc`). The list lives in a file so
the command stays under Vercel's length cap. A line starting with `!` is an
exclude glob (`**` crosses directories): a change only to files it matches
counts as unchanged. The script builds on a bare `!` or a list of excludes
alone (#3681); the ops list has none, the frontend's excludes tests and
screenshots. The haven-ai-frontend project
runs the same script with its own watch file
(`docs/operations/dev-environment.md`). The script skips a build only when
nothing watched changed since the commit this project last **deployed**
(`VERCEL_GIT_PREVIOUS_SHA`). A production build goes ahead whenever that
cannot be proven: the variable is unset or empty, the commit is missing from
Vercel's shallow clone, or git errors. Any `VERCEL_ENV` other than
`preview`, including none, counts as production, and so does a preview of
the `dev` or `main` branch. A preview with no earlier deployment (a
branch's first push) instead compares the branch with its merge base with
`dev`. Vercel clones the deployed branch alone, so the script first fetches
`dev`'s recent history. It tries `origin`, then the repository's public
GitHub URL. If the shallow histories share no commit, it deepens the clone
once. The first log after #3601 could not tell a failed fetch from a missing
shared commit, so the script covers both (#3594). It skips only when that yields a merge base and nothing watched
changed on the branch, and builds on any failure. The build log's
`vercel ignore-build:` line names the step that failed. Since #3681 no PR
branch deploys the console, so this preview path is unused here; the frontend
project takes it only for opt-in `preview/*` branches (#3821). The rule
never compares against the newest commit's parent: that form (#3580)
stranded the #3581 fix, whose own build was lost to the cap, behind later
frontend-only commits (#3591). If a console change still is not live, use
Deployments → Create Deployment with the fix's commit on `dev`.

**Rebuilding an unchanged commit.** Changing `NEXT_PUBLIC_OPS_ENVIRONMENTS`
(step 3, or adding `prod` below) needs a rebuild, because Next inlines it at
build time, but nothing in git changed, so the ignore step skips. Set the
project environment variable `OPS_FORCE_BUILD` to `1` in the **Production**
scope only, redeploy the latest `dev` deployment, then delete
`OPS_FORCE_BUILD`; left in place it makes every production push build. Two consequences of the watched list:

- The **frontend** project rebuilds on `packages/ui` changes through its own
  watch file, `scripts/vercel/watch/frontend.txt`, which its test checks
  against the frontend's real build inputs; the ops list does not decide it.
- A docs-only change rebuilds the console only when it touches
  `scripts/docs`. (It can still rebuild the frontend, which serves the docs
  its `serve-docs.mjs` ALLOWLIST names — that project's watch file lists them.)

**Previews cannot sign in, by design.** Since #3681 there are none (the
console deploys from `dev` only), and the rule below stays the reason not to
re-enable them. A per-PR preview's Vercel origin is
not in any backend's `OPS_REDIRECT_ORIGINS`, so the sign-in round trip
refuses it (`return_to is not an allowed ops origin`). Keep the Preview
scope's `NEXT_PUBLIC_OPS_ENVIRONMENTS` free of the `prod` key — the app
additionally strips `prod` from every preview deployment, but do not rely on
that alone.

### 2. The GitHub OAuth App

GitHub → Settings → Developer settings → OAuth Apps → New OAuth App:

- **Application name:** Haven Ops (or per environment: Haven Ops Dev).
- **Homepage URL:** the console's production domain from step 1.
- **Authorization callback URL:** `<backend origin>/ops/auth/github/callback`
  — the backend's own origin (step 3's `OPS_PUBLIC_ORIGIN`), not the
  console's. The backend builds the redirect URI from that origin and
  GitHub must accept it verbatim.
- **Scopes:** none. Leave the scope box empty; the console never reads
  GitHub data beyond the authenticated `/user`.

### 3. The backend env vars (#3509)

Set on the **backend** (the Railway dev project service), all six
`OPS_*` sign-in variables — a partly configured console stays OFF and every
`/ops/*` route answers 404:

| Variable | Value |
|---|---|
| `OPS_GITHUB_CLIENT_ID` | The OAuth App's client id. |
| `OPS_GITHUB_CLIENT_SECRET` | The OAuth App's client secret. Never logged. |
| `OPS_JWT_SECRET` | `openssl rand -base64 48`. At least 32 characters; must differ from the backend's `JWT_SECRET` (the boot refuses equality). This is the kill switch — [rotating it](#adding-or-removing-a-founder-and-the-kill-switch) signs everyone out. |
| `OPS_ALLOWED_GITHUB_IDS` | Comma-separated numeric GitHub user ids (`https://api.github.com/users/<login>` → `id`) — never login names, which can be renamed and re-claimed. |
| `OPS_REDIRECT_ORIGINS` | The console's **exact** production origin from step 1, e.g. `https://haven-ops.vercel.app`. Scheme and host only — no path, no trailing slash, no `*.vercel.app` wildcard (anyone can deploy there; the parser refuses one). Add a second origin only when a second console deployment really signs in. |
| `OPS_PUBLIC_ORIGIN` | The **backend's own** public origin, e.g. `https://havenbackend-dev-8b95.up.railway.app`. It is the ops token's issuer and the base of the OAuth callback URL — it must match the OAuth App's registered callback base exactly. |

Then set on the **ops app in Vercel**, per environment:

| Vercel environment | `NEXT_PUBLIC_OPS_ENVIRONMENTS` |
|---|---|
| Production | `{"dev":"https://havenbackend-dev-8b95.up.railway.app"}` — the dev backend. |
| Preview | The same dev entry, never a `prod` key. |

A change to this value on an existing project takes effect only after a
rebuild of the console, which the ignore step skips for an unchanged commit:
see *Rebuilding an unchanged commit* in step 1.

Redeploy the backend after setting the six. It refuses to boot on a
malformed origin, allowlist entry or short secret rather than degrading —
fix the value, do not work around the parser.

Without `OPS_DATABASE_URL` (step 4) the console's data routes answer 404
while sign-in still works; there is no fallback to the main database login.

### 4. The read-only database role (#3510)

The console reads customer data through its own Postgres login, never the
backend's. The full procedure — print the role script, run it, give the
role a login, set `OPS_DATABASE_URL`, re-run after migrations that add
columns or tables the console should read — is
[`ops-readonly-role.md`](ops-readonly-role.md). In short:

1. `npm run -s ops:readonly-role-sql -w packages/backend > ops-role.sql`
   and run it as the database owner (it creates `haven_ops_readonly`, then
   grants exactly the column allowlist, or refuses).
2. `ALTER ROLE haven_ops_readonly LOGIN PASSWORD '<openssl rand -base64 32>';`
3. Set `OPS_DATABASE_URL` on the backend to that login (same private-network
   host as `DATABASE_URL`) and redeploy.

### 5. The ops-app registry entry

The registry entry IS the `NEXT_PUBLIC_OPS_ENVIRONMENTS` value from step 3 —
one JSON object mapping the environment labels the switcher shows to backend
origins. Origins must be `https` (`localhost` may be `http` for a local
backend). When you add an environment here, the backend there needs its own
six `OPS_*` variables (step 3) with this console's origin in its
`OPS_REDIRECT_ORIGINS` — both ends must know each other or sign-in fails
closed.

## Add prod later

The same Vercel project and the same branch serve it — no second project, no
second branch:

1. Deploy the prod backend (Railway prod project) with its own six `OPS_*`
   variables: its own `OPS_JWT_SECRET`, the same OAuth App's client
   credentials (add the prod backend's callback URL to the OAuth App, or
   create a second app), and `OPS_REDIRECT_ORIGINS` naming this same
   console origin.
2. Add a `prod` entry to the Production scope's
   `NEXT_PUBLIC_OPS_ENVIRONMENTS`: `{"dev":"https://…","prod":"https://…"}`.
   The switcher gains the key, the red banner arms on it, and the console
   opens on `prod` by default when it is present. Then rebuild the console:
   see *Rebuilding an unchanged commit* in step 1.
3. Run the read-only role script (step 4) on the prod database.
4. A founder completes the epic's product-verification walk on the deployed
   URL — sign in, switch environments, open a customer, run one search —
   and posts masked evidence on the tracking issue.
5. Decide the `ops_access_log` retention (12 months is the epic's figure)
   and record it — enforcement is an operator decision, not code.

## Adding or removing a founder, and the kill switch

- **Remove a founder:** drop their numeric id from `OPS_ALLOWED_GITHUB_IDS`
  on that backend and redeploy. It takes effect on their NEXT request — the
  backend re-checks the id on every call, so the lockout is immediate even
  though their token has hours left. Add a founder the same way.
- **Kill switch:** rotate `OPS_JWT_SECRET` (generate, set, redeploy). Every
  outstanding token everywhere fails verification at once and everyone
  signs in again — use it when an allowlist removal is not enough (a lost
  laptop, a suspected token leak).
- Sign-in itself requires the GitHub account to have 2FA enabled; the
  backend refuses `two_factor_enabled: false`.
- Per-PR previews never hold a sign-in path, so a leaked preview link is
  inert. Since #3681 the console deploys from `dev` only, so no new ones
  are created; the preview defences stay as defence in depth.

## Querying the audit log

One row per sign-in (allowed or denied), search, view and reveal, written
before the response is sent:

```sql
SELECT created_at, operator_login, action, target_type, target_id, field, detail
FROM ops_access_log
ORDER BY created_at DESC
LIMIT 100;
```

- `action` is a closed set: `sign_in`, `sign_in_denied`, `view`, `search`,
  `reveal`.
- `detail` on a search row carries the MASKED term only — never the raw
  query, which may be a customer's email.
- The table lives on the main database and the read-only role is never
  granted it, so the console cannot read its own audit trail.
- A row that could not be written fails the request (503) — the console
  never shows data it could not record showing.

## Vercel Deployment Protection (optional)

The console's own authentication is the boundary; Deployment Protection is
optional defence in depth on top of it. Enabling **Vercel Authentication**
on the project puts a Vercel login in front of every deployment, so even the
unauthenticated render of the sign-in screen is not reachable without a
Vercel seat. Do not let it stand in for anything the console actually
guards — the audit trail, the allowlist and the read-only role are the
controls that matter; this only trims who can reach the front door.
