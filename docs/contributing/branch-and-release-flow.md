---
owner: "@d-hinders"
status: current
covers:
  - .github/workflows/dev-gate.yml
  - .github/workflows/release.yml
  - .github/workflows/promotion-digest.yml
  - .github/workflows/publish.yml
last-verified: "2026-06-29"
---

# Branch & release flow

The canonical reference for how work flows from a branch to dev to production,
how issues close, and how we track what's actually in prod. If you only read one
thing about our git/release model, read this.

## TL;DR

```
feature/* or claude/*  →  dev  →  main
                          (default)   (production)
```

- **`dev` is the default branch.** Feature work branches off `dev` and PRs into
  `dev`. Merging to `dev` deploys to the **dev environment** and — because `dev`
  is the default branch — **closes any issue referenced with `Closes #<n>`**.
- **A closed issue means "implemented and on `dev`"**, not "in production".
- **`main` is production.** Only `dev` or `hotfix/*` may merge in (enforced by
  `dev-gate`). Each promotion to `main` cuts a **`prod-*` GitHub Release** and
  refreshes the **pending-promotion** issue.

## Branches

| Branch | Role | Deploys to | Merging here… |
|---|---|---|---|
| `feature/*`, `claude/*` | short-lived work | — | — |
| **`dev`** | default + integration | dev environment | closes `Closes #` issues |
| **`main`** | production | prod | cuts a prod release; publishes npm packages |
| `hotfix/*` | emergency prod fix | — | only direct-to-`main` path |

The `dev-gate` workflow (`.github/workflows/dev-gate.yml`) lets only `dev` or
`hotfix/*` merge into `main`; a `feature/*`/`claude/*` PR aimed at `main` fails
the gate — retarget it to `dev`.

## Issue lifecycle (implementation, not promotion)

| State | Meaning |
|---|---|
| open, no PR | not started |
| open, with an open PR | in progress |
| **closed** | **implemented and on `dev`** (the dev-merge fired `Closes #`) |

Issue state tracks **implementation**, never prod. Don't reopen an issue to mean
"not in prod yet" — that's what the promotion tracking below is for. For an
**epic**, sub-issues close on their own dev-merges and the epic burns down; close
the epic when its last sub-issue lands on `dev`.

> Note: closing keywords only fire on merge to the **default branch**. That's why
> `dev` is the default — so they fire on the dev-merge. A PR merged to `main`
> (the dev → main promotion) won't re-close anything; the issues are already
> closed from the dev-merge.

## Promotion to production (`dev → main`)

1. Open a **`dev → main` PR** (a human step). Its diff is the promotion manifest
   — exactly what's about to go live.
2. Merge it. On the push to `main`:
   - **`release.yml`** cuts a **`prod-<timestamp>` GitHub Release** with
     auto-generated notes listing the PRs in this promotion (anchored to the
     previous `prod-*` release). This is the durable "what's in prod, and when".
   - **`publish.yml`** publishes any changed npm packages (a separate, version-
     driven concern — see [`../../scripts/README.md`](../../scripts/README.md)).
3. The pending-promotion digest updates to show `dev` and `main` back in sync.

## What's in prod vs. pending

- **In prod (history):** the [**`prod-*` GitHub Releases**](https://github.com/d-hinders/Haven-AI/releases)
  — one per promotion, each with its PR list.
- **Awaiting promotion:** the **📦 "Pending promotion: dev → main"** issue, kept
  current by `promotion-digest.yml` (weekly + on-demand via *Run workflow*). The
  `main...dev` compare is the same view on demand.

## Workflows in this flow

| Workflow | Trigger | Does |
|---|---|---|
| `dev-gate.yml` | PR into `main` | blocks anything but `dev`/`hotfix/*` |
| `release.yml` | push to `main` | cuts the `prod-*` Release |
| `promotion-digest.yml` | weekly + manual | upserts the pending-promotion issue |
| `publish.yml` | push to `main` | publishes changed npm packages |

## One-time setup

Set **Settings → General → Default branch → `dev`** (the lever that makes issues
close on dev-merge). Full ruleset/auto-merge setup is in
[`autonomous-pr-loop.md`](autonomous-pr-loop.md) → "One-time GitHub setup".

## For agents (and `/ship-next`)

- Branch off `dev`; open PRs with base `dev`; include `Closes #<n>` — the
  dev-merge closes the issue. **Don't** manually close issues, and **don't** read
  "issue closed" as "shipped to prod".
- Promotion to prod is a separate human step; prod state lives in the `prod-*`
  Releases and the pending-promotion issue.
