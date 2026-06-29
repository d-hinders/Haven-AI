---
owner: "@d-hinders"
status: current
covers:
  - .github/workflows/dev-gate.yml
  - .github/workflows/publish.yml
  - docs/operations/dev-environment.md
last-verified: "2026-06-29"
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
- [ ] The change set has **soaked on `dev`** — exercise the key flows against the
      dev URL (login, balances, one x402 / payment happy path).

## Open and review the PR (base `main`, head `dev`)

- [ ] Skim the **cumulative diff since the last promotion**. This is the real
      second look at **money-path** changes that were approved in-session on `dev`
      — confirm nothing changes *who can move funds* or *auto-execute vs. queue*
      unintentionally.
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
