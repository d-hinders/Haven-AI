---
owner: "@d-hinders"
status: current
covers:
  - .github/workflows/dev-gate.yml
  - .github/workflows/publish.yml
  - .github/workflows/qa-dev.yml
  - .github/workflows/qa-live.yml
  - docs/operations/dev-environment.md
last-verified: "2026-08-05"
---

# Promoting `dev → main` (production release)

Merging `dev → main` deploys to **production** (Railway + Vercel) and, if the
batch includes a version bump, publishes the npm packages. It is a deliberate,
human-run step — the prod circuit-breaker that sits in front of everything the
loop and contributors merged into `dev`. Run it on a cadence, not per-merge.

Only `dev` (or a `hotfix/*` branch) may open a PR into `main` — the
[`dev-gate`](../../.github/workflows/dev-gate.yml) workflow enforces it. For the
branch model that feeds `dev`, see
[`../contributing/pr-workflow-checklist.md`](../contributing/pr-workflow-checklist.md);
for how the environments are wired, see
[`dev-environment.md`](./dev-environment.md).

## Before opening the promotion PR

- [ ] `dev` CI is green, and the **dev environment is healthy** — the Railway/
      Vercel dev deploys are live with no errors in recent logs.
- [ ] Manually dispatch **QA — money-flow (dev)** from `dev` and confirm all
      scenarios pass, or link and assess every known failure. See
      [`agent-qa.md`](./agent-qa.md) for secrets, funding, commands, and result
      interpretation.
- [ ] Run **QA — live smoke (dev)** against the branch-tracking `dev` preview (the canonical dev URL in [dev-environment.md](dev-environment.md)) and review
      its Playwright artifact if it fails.
- [ ] The change set has **soaked on `dev`** — exercise the key flows against the
      dev URL (login, balances, one x402 / payment happy path).

## Open and review the PR (base `main`, head `dev`)

- [ ] Skim the **cumulative diff since the last promotion**. Since #1024 removed
      the in-session money-path pause, this is the **only** human look at
      money-path changes before prod — read it as such. Confirm nothing changes
      *who can move funds* or *auto-execute vs. queue* unintentionally.
- [ ] **Money-flow QA coverage is now checked automatically** ([#1030](https://github.com/d-hinders/Haven-AI/issues/1030)):
      `qa-freshness` fails if any money-path file changed after the newest green
      `qa-dev` run, naming the offending commits. You no longer have to verify
      this by hand — if the gate is green, the run covered the money path. If it
      fails, re-run *QA — money-flow (dev)* rather than reaching for
      `qa-override`.
- [ ] **Migrations:** list every migration included since the last promotion.
      Confirm each is **forward-only / safe on existing rows**, and that a
      **prod DB snapshot** exists before they run on deploy.
- [ ] **No dev-only config leaks into prod:** production leaves
      `NEXT_PUBLIC_HAVEN_ENV` unset (no `DEV` badge) and keeps its own
      secrets / relayer key / RPCs (these live on the platforms, not in code —
      just confirm nothing dev-specific was hardcoded).
- [ ] **npm:** if the batch includes a version bump, `publish.yml` publishes on
      merge — confirm the version and the intended dist-tag (`alpha` vs `latest`).
- [ ] Required checks are green, `dev-gate` passes, and a code-owner approval is
      present if the batch touches an owned path (migrations / release tooling /
      CODEOWNERS).

## Merge, deploy, and verify prod

- [ ] Merge the promotion PR.
- [ ] Watch the **prod deploys** finish (Railway backend / MCP, Vercel frontend)
      and confirm the **migrations applied cleanly** to the prod DB.
- [ ] **Prod smoke:** load the prod app (no `DEV` badge), check login + balances,
      and run one small real payment / x402 happy path as a canary.
- [ ] Watch prod error logs for a few minutes. If anything is off, **roll back**
      (Railway redeploy-previous / Vercel instant rollback) and, if a migration is
      implicated, restore from the pre-deploy snapshot.

## Production deploy drift (open, 2026-08-06)

Verify the frontend on `haven-ai-frontend.vercel.app` — **not** on
`haven-ai-frontend-git-main-…vercel.app`. The latter is Vercel's branch alias for
`main`, and it is currently misleading in two ways at once: it serves a
different build from the production alias, and its `/api/*` proxies to the **dev**
backend (`/api/chains` returns the dev backend's response), which means the newest
`main` deployment was built with Preview-scope env vars. So a "prod smoke" run
there would be testing dev.

Related and unresolved: `main` has not moved since **2026-06-26**, so production
is well behind `dev`, and the production alias serves a build whose backend
predates the `/chains` route. Before the next promotion, confirm in the Vercel
project settings which branch is set as **Production Branch** and which
deployment the production domain is assigned to — a promotion merge is only
guaranteed to reach production if `main` pushes actually produce Production
deployments.
