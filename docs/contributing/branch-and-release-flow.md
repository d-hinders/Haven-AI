---
owner: "@d-hinders"
status: current
contract: true
covers:
  - .github/workflows/dev-gate.yml
  - .github/workflows/release.yml
  - .github/workflows/promotion-digest.yml
  - scripts/ci/promotion-digest-metrics.mjs
  - scripts/release-bump.mjs
  - scripts/ci/qa-freshness.mjs
  - .github/workflows/publish.yml
last-verified: "2026-09-11"
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

> **Every keyword in this document is quoted, never emitted — write yours bare
> (#2382).** The code spans around `Closes #<n>` and `Refs #<n>` on this page are
> the doc writing *about* the keyword, in a form GitHub does not parse; they are
> not part of what you type. The rule is stated once, in
> [`autonomous-pr-loop.md`](autonomous-pr-loop.md), and quoted here rather than
> rephrased: *"The keyword you actually emit is bare, in the body, the
> pull-request title and the commit messages alike; the pull-request template's
> Issue Link placeholders are bare for the same reason."* A backticked keyword in a
> **body** reads as correct and closes nothing — GitHub's body parse respects
> Markdown rendering (PR #2364, #2382) — while the same bytes in a **commit
> message** or the **title**, which nothing renders, do close the issue (#2320).
>
> That asymmetry is why bare is a rule and not a style. Every way of quoting or
> escaping the keyword that has been tried either still fires or hides it from
> the merge-time guard while GitHub still acts: a fenced or blockquoted keyword
> is parsed — a code span in a commit message is how #2268 was closed a second
> time, by the pull request that shipped the guard; an HTML entity is decoded by
> GitHub before parsing, while the guard's regex sees only the raw bytes. The
> guard's own reading had a blind spot of the same shape until #2337: a keyword
> straddling the 70th character of a commit subject came back from
> `gh pr view --json commits` split mid-token, invisible to the guard and live
> to GitHub. All three were measured in #2337, where the guard grew its
> commit-message and title readers. Bare is the one form GitHub and the guard
> read identically. The
> `Refs #<n>` exception above is the one case the bare *closing* keyword is
> wrong — and `Refs` is written bare too, so the issue stays linked.

## Branches

| Branch | Role | Deploys to | Merging here… |
|---|---|---|---|
| `feature/*`, `claude/*` | short-lived work | — | — |
| **`dev`** | default + integration | dev environment | closes `Closes #` issues; publishes `@haven_ai/*@dev` snapshots |
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
   — exactly what's about to go live. **`dev` is held from here until the merge**,
   because the PR's head is the branch and not a pinned SHA; see
   [`../operations/promoting-dev-to-main.md` § *The promotion window*](../operations/promoting-dev-to-main.md#the-promotion-window--dev-is-held-while-the-pr-is-open)
   for the consequences and what to do when something must land anyway.
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
     Moving `latest` onto what was just published is a **separate job**,
     `promote-tags`, not a step of the publish ([#2647](https://github.com/d-hinders/Haven-AI/issues/2647)).
     It has to be: publishing authenticates by npm Trusted Publishing (OIDC),
     which authorises `npm publish` and nothing else, so the tag move needs a
     long-lived token — and a GitHub Environment, the only `main`-only scoping
     that exists, is job-level. Read the consequence into your promotion
     checks: a promotion can be **half green**. If `promote-tags` fails, the
     versions are live under `alpha` and `latest` still points at the previous
     release; that is the 0.1.35-alpha.0 outcome, and the fix is to repair the
     credential and re-run that job, never to re-cut a version.
     This promotion is still the **only** path that publishes to `alpha` or
     `latest`. The `dev` snapshots the same workflow publishes on pushes to
     `dev` are not releases — `0.0.0-dev.*`, tag `dev`, nothing committed —
     and neither a bump nor a promotion is involved in producing one; the
     loop and its operator steps are in
     [`../operations/package-dev-channel.md`](../operations/package-dev-channel.md).
3. The pending-promotion digest updates to show `dev` and `main` back in sync.

> **Never revert a published release bump — cut forward instead
> ([#2580](https://github.com/d-hinders/Haven-AI/issues/2580)).** Once a version
> is on npm it cannot be unpublished after 72 hours, and the dist-tags keep
> pointing at it. Reverting the merge only rewinds `package.json`, so the repo
> then sits *below* the live `latest` — and the next ordinary bump looks forward
> locally while actually moving `latest` backwards when it publishes, serving
> users an older build.
>
> Worked example: 4.0.0 is released and `latest` is 4.0.0; a bug is found and
> the merge is reverted, so `package.json` reads 3.0.9; the next patch bump to
> 3.0.10 passes every check and drags `latest` down to it.
>
> The fix for a bad release is a **new, higher version containing the revert**
> (`git revert` the code, then bump forward), plus `npm deprecate` on the bad
> version if it warrants it. `release-bump.mjs` refuses a bump that is backwards
> or unchanged relative to the repo's current version, but it is offline and
> cannot see the registry — it does not catch this case, which is why the rule
> is written here rather than enforced there.

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
- **`dev` is squash-only, and that is a third ruleset.** Feature and release PRs
  into `dev` are **squash-merged**, enforced since 2026-09-07 by a `dev`-only
  ruleset named *Dev merge* ([#2632](https://github.com/d-hinders/Haven-AI/issues/2632)).
  The two branches' rules are exact opposites, and merge methods **intersect**
  across matching rulesets — which is why neither restriction can live in
  `Haven automerge rules` (it covers both branches, so narrowing it to squash
  would leave `main` with no permitted method at all, and narrowing it to merge
  commits would force those onto `dev`). Each restriction therefore sits on a
  ruleset that targets one branch: `Dev gate` for `main`, `Dev merge` for `dev`.

**Docs drift is swept at promotion, not per PR (#2638).** The promotion checklist
carries an item to read the weekly staleness audit and disposition every
`current` doc it ranks — fix, file, or accept with a reason in the promotion PR.
That is deliberate division of labour: a `contract: true` doc is blocked on the
PR that made it stale by the coupling gate, so it never reaches here, while
non-contract docs are allowed to drift on `dev` between promotions and this is
where they are caught. The item and its dispositions live in
[`../operations/promoting-dev-to-main.md`](../operations/promoting-dev-to-main.md);
do not restate them here.

**The prod bar, as a list.** A promotion PR must satisfy **19** required
contexts — the 15 that every PR into `dev` also meets, plus four that are
required on `main` only:

- **`gate`** — only `dev` or `hotfix/*` may merge into `main`.
- **`qa-freshness`** — a green money-flow QA run must cover the promoted
  money-path code ([#1030](https://github.com/d-hinders/Haven-AI/issues/1030));
  bypass is `qa-override`.
- **Design visual regression** — required on `main` since 2026-09-07 (#2632),
  where it replaces the blocking role it used to play on `dev` PRs.
- **Frontend browser smoke** — required on `main` since the same change.

On top of those, `main` is the only branch still requiring the branch to be up
to date, and the only one restricted to merge commits. The per-branch inventory
and the `gh api` command that produced it live in
[`autonomous-pr-loop.md`](autonomous-pr-loop.md#one-time-github-setup-required)
step 3 — read the numbers there, not here. The operational checklist a human
runs alongside the gates is
[`../operations/promoting-dev-to-main.md`](../operations/promoting-dev-to-main.md).

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
  current by `promotion-digest.yml` — refreshed on **every merge to `dev`** (each
  one adds to the pending count) and **on every promotion** (push to `main`, so it
  flips to ✅ as soon as prod catches up), daily for the trailing-7-day figures,
  which age with time rather than with pushes, and on-demand via *Run workflow*.
  The `main..dev` compare is the same view on demand.

  The `dev` trigger is the load-bearing one, and it is the load-bearing one
  because of how this digest fails. Refreshing only on a push to `main` means a
  stalled promotion — no push to `main`, by definition — leaves a stale count
  standing, and a stale count here is an *understated* one, so the breakage reads
  as reassurance. `dev` is the branch whose movement is the number, so it cannot
  go quiet while the backlog grows. `guard-freshness.yml` documents the same
  principle: a cron watching a cron dies with it.

  It is **one long-lived issue, deliberately**: the workflow upserts by the
  `promotion` label, so closing it just makes the next run open a duplicate under
  a new number. It's **pinned** rather than recreated — a bot-maintained tracker
  wants a stable identity, and pinning is what keeps it visible. Leave it open.

  Since [#2767](https://github.com/d-hinders/Haven-AI/issues/2767) the same body
  ends with a **Filing bar** section: two figures over the trailing seven days,
  each followed by the command that reproduces it — issues filed per issue
  closed (target < 0.3) and product PRs as a share of merges to `dev` (target
  > 60 %). They are the trend line for `ship-next` § *Filing bar*; the rule
  lives there, the digest only measures it.

## Workflows in this flow

| Workflow | Trigger | Does |
|---|---|---|
| `dev-gate.yml` | PR into `main` | `gate`: blocks anything but `dev`/`hotfix/*`. `qa-freshness`: blocks unless a green money-flow QA run covers the promoted money-path code; a money-path `hotfix/*` blocks outright ([#1030](https://github.com/d-hinders/Haven-AI/issues/1030)). Bypass: `qa-override`. |
| `release.yml` | push to `main` | cuts the `prod-*` Release |
| `promotion-digest.yml` | push to `dev` + push to `main` + daily + manual | upserts the pending-promotion issue; since [#2767](https://github.com/d-hinders/Haven-AI/issues/2767) the body also carries two trailing-7-day figures with their reproducing commands — issues filed per issue closed and product PRs as a share of `dev` merges (`scripts/ci/promotion-digest-metrics.mjs`) |
| `publish.yml` | push to `main` | **prod channel**: publishes packages whose version isn't yet on npm, under the tag its version implies (`alpha`/`latest`), then hands them to the `promote-tags` job, which moves `latest` onto each one (#2536, split out by [#2647](https://github.com/d-hinders/Haven-AI/issues/2647)) so a bare `npm install`/`npx` gets the newest release. Two jobs, two outcomes: publish can succeed while the tag move fails |
| `publish.yml` | push to `dev` | **dev channel** ([#2421](https://github.com/d-hinders/Haven-AI/issues/2421)): publishes a `0.0.0-dev.<ts>.<sha>` snapshot of all five packages under the `dev` tag. Same file, by necessity — npm trusted publishing is pinned to the workflow filename. Runbook: [`../operations/package-dev-channel.md`](../operations/package-dev-channel.md) |

## One-time setup

Set **Settings → General → Default branch → `dev`** (the lever that makes issues
close on dev-merge). Full ruleset/auto-merge setup is in
[`autonomous-pr-loop.md`](autonomous-pr-loop.md) → "One-time GitHub setup".

## For agents (and `ship-next`)

- Branch off `dev`; open PRs with base `dev`; include `Closes #<n>`, written
  bare (see the note under the TL;DR) — the dev-merge closes the issue. **Don't**
  manually close issues, and **don't** read
  "issue closed" as "shipped to prod".
- **Except in operator-verify mode:** when a human operator step is still
  outstanding, label the issue `operator-verify` and reference it as `Refs #<n>`,
  so the merge leaves it open — **in the commit messages and the title as well as
  the body**, since all three reach `dev` (#2320). A required check fails the PR if
  a closing keyword targets such an issue, wherever on the PR it is written — the
  rule is enforced rather than remembered (#2276).
- Promotion to prod is a separate human step; prod state lives in the `prod-*`
  Releases and the pending-promotion issue.
