---
owner: "@d-hinders"
status: current
contract: true
covers:
  - .github/workflows/dev-gate.yml
  - .github/workflows/release.yml
  - .github/workflows/promotion-digest.yml
  - .github/workflows/publish.yml
last-verified: "2026-08-16" # #1500: Branch-lifetime section added; the #1335/#1336 sync-back rule (dev re-absorbs main's merge commit post-promotion) still holds
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

### Branch lifetime: one branch per PR

"Short-lived" above is a rule, not a mood: a work branch is **cut fresh from
current `origin/dev`, carries exactly one PR, and dies on merge**. Reusing one
branch for a sequence of PRs manufactures merge conflicts — the #1500 evidence
was six `Merge branch 'dev' into <branch>` resyncs in one day from a single
6-PR branch, against zero the next day at the same volume on per-PR branches.
The cost is worse than the resync itself: a stale branch's CONFLICTING PR
produces **no** `pull_request` check runs, so an armed auto-merge silently
never fires and the queue stalls (#1366).

**Sessions launched with a pinned "designated branch"** (Claude Code's remote
environments inject one, with an instruction never to push elsewhere): do not
stack PRs on the branch's previous state. Reset it from `dev` before each new
piece of work:

```sh
git fetch origin dev && git checkout -B <designated-branch> origin/dev
```

**Guard before resetting:** the branch's previous PR must already be
**merged** — `gh pr list --head <designated-branch> --state open` must come
back empty. The mechanics of why: `checkout -B` is purely local and touches
nothing remote; the hazard is the **push** that follows. Under a still-open PR
the histories have diverged, a plain push is rejected as non-fast-forward, and
the only way through is a force push — which rewrites the open PR's head and
orphans its work. Once the previous PR has merged, the repo's
delete-branch-on-merge setting has already removed the remote branch, so the
next plain push simply recreates it — no force needed. Never force-push a
designated branch. If a PR is open, wait for its merge or escalate. This is
#1500's interim option 3 — the clean fix, launching sessions without a
long-lived pinned branch, is an environment setting owned by whoever
configures them, not something a session can change from inside.

**Whether any of this is working is a number, not an impression:**

```bash
npm run branch-hygiene
```

It reports, over a window of `dev`'s history, how many work branches went
stale under `dev` and how many diverged between local and remote under one
name — the two shapes this section exists to prevent. It counts every form a
resync actually takes (`git merge dev` and `git pull origin dev` produce
different subjects) and deliberately does not count `main` into a branch:
that is release reconciliation, a different act with a different cause. Zero of
both is the target state. It REPORTS rather than gates on purpose: these
commits are evidence of a launch configuration, and the contributor who would
trip a gate is never the one who can change it.

Measure a specific window with `--since` / `--until` (ISO dates), or `--json`
for a machine-readable summary. Against #1500's original evidence window it
reproduces that issue's table exactly — 6 resyncs and 1 divergence in one day,
four of the six from a single branch left open for 7.5 hours.

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
   - **`publish.yml`** publishes packages whose version isn't yet on npm — a
     version-gated step, so a promotion that didn't bump a version is a no-op
     here. One package's failure doesn't abort the others (#1159): every
     package is attempted and the run summary reports each outcome, so read
     the per-package table — green-except-one is a real outcome (a separate
     concern — see [`../../scripts/README.md`](../../scripts/README.md)).
3. The pending-promotion digest updates to show `dev` and `main` back in sync.

Promotions merge with a **merge commit**, never squash: a squashed promotion
leaves `main` with a history-less copy of the batch, and the next promotion
conflicts en masse once `dev` has refactored any of those files (#1152 → #1172;
repaired by the `-s ours` reconcile merge #1173).

**After every promotion, sync `main`'s merge commit back into `dev`.** The
`main` ruleset enforces strict up-to-date status checks, so the NEXT promotion
PR reports BEHIND — `dev` lacks exactly one commit, the previous promotion's
merge commit — and cannot merge on approval alone. Direct pushes to `dev` are
ruleset-declined; the sync travels as a PR carrying `git merge origin/main`
(zero content change, history only) and MUST itself be MERGE-merged — a squash
would flatten away exactly the commit being synced. First done as #1231.

## What's in prod vs. pending

- **In prod (history):** the [**`prod-*` GitHub Releases**](https://github.com/d-hinders/Haven-AI/releases)
  — one per promotion, each with its PR list.
- **Awaiting promotion:** the **📦 "Pending promotion: dev → main"** issue, kept
  current by `promotion-digest.yml` — refreshed **on every promotion** (push to
  `main`, so it flips to ✅ as soon as prod catches up), weekly for drift piling
  up on `dev`, and on-demand via *Run workflow*. The `main..dev` compare is the
  same view on demand.

  It is **one long-lived issue, deliberately**: the workflow upserts by the
  `promotion` label, so closing it just makes the next run open a duplicate under
  a new number. It's **pinned** rather than recreated — a bot-maintained tracker
  wants a stable identity, and pinning is what keeps it visible. Leave it open.

## Workflows in this flow

| Workflow | Trigger | Does |
|---|---|---|
| `dev-gate.yml` | PR into `main` | `gate`: blocks anything but `dev`/`hotfix/*`. `qa-freshness`: blocks unless a green money-flow QA run covers the promoted money-path code; a money-path `hotfix/*` blocks outright ([#1030](https://github.com/d-hinders/Haven-AI/issues/1030)). Bypass: `qa-override`. |
| `release.yml` | push to `main` | cuts the `prod-*` Release |
| `promotion-digest.yml` | push to `main` + weekly + manual | upserts the pending-promotion issue |
| `publish.yml` | push to `main` | publishes packages whose version isn't yet on npm |

## One-time setup

Set **Settings → General → Default branch → `dev`** (the lever that makes issues
close on dev-merge). Full ruleset/auto-merge setup is in
[`autonomous-pr-loop.md`](autonomous-pr-loop.md) → "One-time GitHub setup".

## For agents (and `ship-next`)

- Branch off `dev`; open PRs with base `dev`; include `Closes #<n>` — the
  dev-merge closes the issue. **Don't** manually close issues, and **don't** read
  "issue closed" as "shipped to prod".
- Promotion to prod is a separate human step; prod state lives in the `prod-*`
  Releases and the pending-promotion issue.
