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

## Run the prod smoke on the right hostname

Vercel lists **three** hostnames under the Production environment. Two are
production; one is a trap:

| Hostname | What it actually serves |
|---|---|
| `haven-ai-frontend.vercel.app` | Production deployment → **prod backend** ✅ |
| `haven-ai-frontend-daniels-projects-f3327ba2.vercel.app` | Same production deployment → **prod backend** ✅ |
| `haven-ai-frontend-git-main-…vercel.app` | **Not production** → dev backend ⚠️ |

The third is the *branch alias* for `main`, and a branch alias always points at
the newest deployment **of that branch, whatever its environment**. On
2026-07-12 someone re-deployed `main`'s tip commit and the redeploy landed as a
**Preview** deployment — so it was built with Preview-scope env vars (dev
backend, `DEV` badge) and it took the alias. Verified 2026-08-06: its
`/api/chains` returns the dev backend's response while both production
hostnames return the prod backend's.

Nothing is misconfigured — Production tracks `main`, the domain is connected to
the Production *environment* rather than pinned to a deployment, and
`NEXT_PUBLIC_API_URL` is scoped to both Production and Preview. It is one stray
deployment holding a confusing name.

- **Never "Promote to Production" that deployment.** It was built with Preview
  env vars, so promoting it would point the production domain at the **dev
  backend** and switch on the dev-only flags.
- To clear it, delete the stray Preview deployment (Deployments → filter `main`
  → the Jul 12 "Redeploy of…" row → ⋯ → Delete). The alias then falls back to
  the production deployment.
- Until then, smoke prod on `haven-ai-frontend.vercel.app` only.

Separately: `main` has not moved since **2026-06-26**, so production is a long
way behind `dev`. That is a promotion backlog, not a deploy bug — the pipeline
below is wired correctly and will deploy whatever you merge.
