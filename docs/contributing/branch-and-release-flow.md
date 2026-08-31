---
owner: "@d-hinders"
status: current
contract: true
covers:
  - .github/workflows/dev-gate.yml
  - .github/workflows/release.yml
  - .github/workflows/promotion-digest.yml
  - .github/workflows/publish.yml
last-verified: "2026-08-31" # #2320/#2327: the two operator-verify passages (the `dev`-default bullet and the agent checklist) both scoped the `Refs #<n>` rule to the pull-request body. Both now name the commit messages and the title, which reach `dev` as well — PR #2314 closed #2268 from a commit while its body was correct. Scope: those two bullets only; the branch model, the promotion/merge-method rules, the issue-state table, the branch-lifetime section and the release wiring were NOT re-verified in this pass. Prior: #2276: the issue-lifecycle half of this doc read as though every merge closes its issue. It does not: ship-next's operator-verify mode ships the code and keeps the issue open for a human step, which `Closes #<n>` silently defeats (#2268, closed by PR #2272's merge). The `dev`-merge bullet, the issue-state table and the agent checklist now carry the `Refs #<n>` / `operator-verify` exception. Scope: those three passages only — the branch model, the promotion/merge-method rules, the branch-lifetime section and the release wiring were NOT re-verified in this pass. Prior: #2165: the never-squash promotion rule is now ENFORCED by the `Dev gate` ruleset (`allowed_merge_methods: ["merge"]` on any PR based on `main`), not left to the reader — it was prose-only and #2161 was squash-merged by a UI default. Section gains the enforcement note, the `hotfix/* → main` answer (branch rulesets gate the ref written to, so head-branch names do not matter) and why `dev` deliberately keeps squash. The rest of the section was re-read against the live rulesets: the BEHIND/sync-back rule and the `-s ours` recovery pointer still hold, and #2162 exercised the sync-back end to end. Prior: #1500: Branch-lifetime section added; the #1335/#1336 sync-back rule (dev re-absorbs main's merge commit post-promotion) still holds
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
  A pull request that must NOT close its issue (ship-next's *operator-verify
  mode*, where a human step is still outstanding) writes `Refs #<n>` instead;
  prose saying the issue stays open does not survive the keyword (#2276). The
  keyword is honoured in the **commit messages** that reach `dev` and in the title
  via the squash subject, not only in the body — so a clean body is not sufficient
  (#2320).
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
| open, labelled `operator-verify` | **implemented and on `dev`**, waiting on a human step — its PR wrote `Refs #<n>` on purpose (#2276) |

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

**Enforced, not remembered ([#2165](https://github.com/d-hinders/Haven-AI/issues/2165)).**
The `Dev gate` ruleset carries a `pull_request` rule with
`allowed_merge_methods: ["merge"]`, so GitHub offers only *Create a merge commit*
on a PR whose base is `main`; squash and rebase are refused by the UI and the API
alike. If you find yourself wondering why the other two buttons are missing, this
is why — and if they reappear, the rule has been dropped from the ruleset and
should be restored, exactly as [`CODEOWNERS`](../../.github/CODEOWNERS) says of
`qa-freshness`.

This was prose only until 2026-08-28, and prose lost: the `0.1.31-alpha.0`
promotion (#2161) went in as a squash because the merge button defaulted to it
and nobody changed it. #2162 repaired the ancestry with an ordinary merge, which
worked **only because `dev` had not moved yet** — the trees were still identical,
so no `-s ours` reconcile was needed. Caught a few commits later it would have
been #1173 again. A rule that has to be re-derived at the moment of action, on
the repository's rarest and highest-consequence merge, through a UI whose default
is sticky and wrong, is not a rule.

Two consequences worth stating, because both are easy to get backwards:

- **`hotfix/* → main` is covered too.** A branch ruleset gates the ref being
  *written to*, so the head branch's name is irrelevant — every PR based on
  `main` gets the same restriction.
- **PRs into `dev` are untouched.** `dev`'s ruleset still allows all three
  methods, deliberately: **feature and release PRs into `dev` are squash-merged**.
  The two rules are exact opposites, which is why the restriction lives in
  `Dev gate` (which targets `refs/heads/main` alone) rather than in
  `Haven automerge rules` (which covers both branches, and would have forced
  merge commits onto `dev` as well).

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
- **Except in operator-verify mode:** when a human operator step is still
  outstanding, label the issue `operator-verify` and reference it as `Refs #<n>`,
  so the merge leaves it open — **in the commit messages and the title as well as
  the body**, since all three reach `dev` (#2320). A required check fails the PR if
  a closing keyword targets such an issue, wherever on the PR it is written — the
  rule is enforced rather than remembered (#2276).
- Promotion to prod is a separate human step; prod state lives in the `prod-*`
  Releases and the pending-promotion issue.
