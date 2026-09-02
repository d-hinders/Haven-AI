---
owner: "@d-hinders"
status: current
covers:
  - .github/CODEOWNERS
  - .github/workflows/dev-gate.yml
  - .github/ISSUE_TEMPLATE/loop-task.md
  - .github/ISSUE_TEMPLATE/loop-epic.md
  - .agents/skills/ship-next/SKILL.md
  - .agents/skills/new-task/SKILL.md
  - .claude/commands/ship-next.md
  - .claude/commands/new-task.md
last-verified: "2026-09-02" # #2273: the "Which runs count, and a known limit" paragraph under gate 2 is #2404's text (PR #2409, merged in parallel) taken verbatim on reconciliation — it already describes the `deployment_status` trigger this change fires, its not-yet-observed status and the #2271 provenance rule; re-read against `.github/workflows/qa-dev.yml` on this branch and left unchanged. Scope: that paragraph only. Prior: #2404: the "Known limit" paragraph of the money-path safety model rewritten against `scripts/ci/qa-freshness.mjs` as changed on this branch — it no longer names `repository_dispatch: dev-deployed` as the trigger where run SHA and deployed SHA coincide (removed by #2273), and now states which runs the gate admits (event allow-list, ancestry of the promotion head, `money-flow` job conclusion) and that the `deployment_status` run it was built to admit has not yet been observed. Scope: ONLY that paragraph; the ruleset inventory, the escape-hatch list, the flake signatures and § *Merge policy A* were NOT re-verified in this pass. Prior: #2385: nine sites in this file illustrate the closing keyword inside a code span (counted on this branch with `grep -n '`Closes #\|`Refs #'`, excluding the front matter and the paragraph this pass adds), every one of them correctly — a doc writing ABOUT the keyword has to use a form GitHub does not parse, which the #2320 paragraph already states. What no sentence said is the other half: the keyword an author EMITS is bare. A reader substituting a real number for the placeholder carries the code span with it, and GitHub's body parse respects Markdown rendering, so that body closes nothing (measured on PR #2364 under #2382: `closingIssuesReferences` empty, #2361 closed by hand). Stated ONCE, in a new paragraph beside the existing #2320 one, rather than at each of the nine illustration sites. Scope: ONLY that new paragraph; the ruleset inventory, the money-path safety model, the flake signatures and § *Merge policy A* were NOT re-verified in this pass. Prior: #2329: § *Known CI flake signatures* gains the `resetDb()`-first backend timeout, on its second sighting (#2274, then #2295's run) — which is what this section's own "observed at least twice" rule requires. Written as a FIXED signature rather than a rerun-once one, with the mechanism, because the entry's job is to stop the next author re-deriving the `dev`-baseline comparison that diagnosed it: a fixed 5000 ms `testTimeout` charged to a harness cost that `vitest.config.ts` budgets at 120 s in hooks, not a test slowing in proportion to load. Measured on this branch against native Postgres: the CI failure reproduces deterministically (exit 1, the exact 5000 ms signature) by holding the migration advisory lock while a cold worker schema runs the file, and passes (exit 0) after the fix. Scope: ONLY the new bullet in § *Known CI flake signatures*; the two existing signatures, the ruleset inventory, the money-path safety model and § *Merge policy A* were NOT re-verified in this pass. The hook/body file counts here are AST-derived against `origin/dev`, not grepped — haven-doc-reviewer caught an off-by-one (48 -> 47) in the first draft that came from an indentation heuristic, and the corrected sentence also names the third category the two-bucket framing had hidden (a file budgeted by its own explicit timeout). Prior: #2320/#2327: the operator-verify paragraph attributed the guard to the pull-request BODY ("or one its own body says stays open") — true of the guard as shipped and false of GitHub, which parses commit messages on the default branch and the squash subject too. That sentence is corrected and a paragraph added naming the three emitters, the absence of a fence/blockquote escape, the forms that ARE safe, and the #2327 narrowing of the stays-open signal to state assertions. Verified against the live repo settings (merge_commit_message=PR_TITLE, squash_merge_commit_message=COMMIT_MESSAGES, squash_merge_commit_title=COMMIT_OR_PR_TITLE) and against PR #2314 as it actually merged — which corrected the anecdote: its body ends `Closes #2276`, its own issue, and never named #2268 with a keyword, so the guard was green on a true answer about the wrong surface. Issue #2320 states this the other way round; `haven-doc-reviewer` caught it. Scope: ONLY the operator-verify paragraph and the one added after it; the ruleset inventory, the money-path safety model, the flake signatures and the escape-hatch list were NOT re-verified. Prior: #2276: the loop's issue-lifecycle claims were unconditional — "each PR includes `Closes #<n>`", "a closed issue is done", "closed = implemented and on dev" — while ship-next's operator-verify mode requires the opposite for a shipped issue awaiting a human step. Three passages now carry the exception and name the `Refs #<n>` form, the `operator-verify` label and the merge-time guard that enforces them. Scope: ONLY those three passages plus the new operator-verify paragraph; the ruleset inventory, the money-path safety model, the flake signatures and the escape-hatch list were NOT re-verified in this pass. Prior: #2268 (follow-up): the "Known limit" paragraph ended by calling the dead `dev-deployed` trigger "a deploy-provider configuration matter" and pointing at an "operator fix" in `agent-qa.md`. That fix turned out not to exist — Railway offers no supported place for the authenticated call, so the same-day correction to `agent-qa.md` now says so, and this sentence contradicted it. Corrected to state that no operator fix exists today and that the replacement route is #2273 (unbuilt). Scope: ONLY that sentence was re-read and edited; the rest of the money-path safety model, the ruleset inventory, the flake signatures and the escape-hatch list were not re-verified in this pass. Prior: #2268: the money-path safety model's "Known limit" paragraph contrasted the `repository_dispatch: dev-deployed` trigger (headSha and deployed SHA coincide) against the nightly cron (they may not) as though both triggers fire. One does not: 0 of 156 `qa-dev.yml` runs, 2026-06-30 -> 2026-08-31, counted against the Actions API, and 0 repository_dispatch runs on any workflow in the repo's history. The paragraph now says so and points at agent-qa.md for the evidence and the operator fix. Raised by haven-doc-reviewer on PR for #2268; this file's `covers:` does not list `.github/workflows/qa-dev.yml`, so the coupling gate could not have found it. Scope: that one paragraph; the `git diff --name-only` rename limit beside it was re-read against `scripts/ci/qa-freshness.mjs` and is unchanged. NOT re-verified: the ruleset inventory, the escape-hatch list, the flake signatures, or any other section. Prior: #2170: ruleset inventory re-verified against `GET /repos/d-hinders/Haven-AI/rulesets`, `GET /repos/d-hinders/Haven-AI/rules/branches/{main,dev}`, and both surviving ruleset definitions. It now names the two active rulesets and attributes the former "Move fast" protections without implying they were removed. Scope: § "One-time GitHub setup", step 3 only. Prior: #2164: § "Be precise about what gate 2 proves" gains the version-only exemption — a money-path file whose entire diff is an IN-PLACE release-bump version bump no longer counts as uncovered — shape-per-line plus symbol pairing, the latter added after review found three behavioural edits that shape matching alone excused. Named in the list rather than left to the script, because it NARROWS the net and an unstated narrowing is the failure this whole section is written against. Scope: that one bullet; the ruleset inventory and § "Merge policy A" were NOT re-verified in this pass. Prior: #2165: the ruleset inventory's "Dev gate" bullet said it enforces two checks; it now also carries a pull-request rule pinning `main` to merge-commits only, so the bullet gained that rule, why it lives in `Dev gate` rather than the ruleset that also covers `dev`, the `hotfix/* → main` answer, and the empirically-confirmed intersection semantics. Scope: that ONE bullet. Two stale claims in the same list were found and deliberately NOT fixed here, filed instead so this bump is not a rubber stamp — the list says "Three active rulesets" and describes a "Move fast, just don't break prod by accident" ruleset that no longer exists (`GET /repos/d-hinders/Haven-AI/rulesets` returns exactly two, 2026-08-28). Its three protections all survive under the remaining rulesets, verified the same day: require-PR and block-force-push are present twice each, and "Lint, Type-check & Build" is still a required context. Nothing else in this file was re-verified. Prior: #2004: § "Known CI flake signatures" re-read and the Base Sepolia RPC entry extended — the backend test job now reaches that endpoint itself (the executable proof of CASP Red Line #4 `eth_call`s the deployed caveat enforcers), and it FAILS rather than skips when the endpoint is unreachable in CI, so this signature can now redden a backend-only PR and not just `qa-dev`. The entry names the transport-vs-policy distinction and the `HAVEN_ENFORCER_PROBE_RPC_URL` override. Scope: that section only; the ruleset inventory, the money-path safety model and § "Merge policy A" were NOT re-verified in this pass. Prior: #1968: §"Merge policy A" re-read — the frontend bullet's "pauses for the user" is now "pauses", with clearing delegated to a clean re-review rather than a human ack, and a new bullet makes an unfilled `haven-reviewer:` verdict line a bar to arming auto-merge at all. The section's own safety claim is "CI + haven-reviewer", which a silently skipped pass makes false with nothing to read it off. The ruleset inventory and the money-path safety model were not re-verified in this pass. Prior: #1607: Known CI flake signatures section added (rerun-once policy; ship-next points here). Prior: #1341: re-verified loop stop and issue-readiness conditions after ship-next gained #1289 active-claim coordination
---

# Autonomous PR loop

**In one line:** hand the loop a list of PRs — as **GitHub issues** (a labeled
standalone task, or an epic's sub-issues) — and it implements, tests, reviews,
opens, and auto-merges them, stopping for a human only on a migration, a real
decision, a live work overlap, or stuck CI.

> **The backlog is GitHub Issues, not a repo file.** Backlogs used to live in
> `docs/backlogs/*.yml`, but with the `dev`/`main` split a committed status file
> drifts out of sync between branches and has to be hand-reconciled. Issues live
> outside git — one source of truth for humans and the loop, on every branch.
> The old YAML tracks have been retired (see `docs/backlogs/README.md`).

Ship a defined set of PRs with minimal human input. You define the work; the
loop implements, tests, reviews, opens, and (for safe PRs) merges each one —
and only comes back to you for a real decision, a blocking review finding, a
live work overlap, or stuck CI.

Pieces:
- **`new-task`** ([canonical skill](../../.agents/skills/new-task/SKILL.md)) — **capture**: turns a one-line description into a well-formed backlog issue (Scope + Acceptance + Surface + Money-path), backlog-only by default.
- **`ship-next`** ([canonical skill](../../.agents/skills/ship-next/SKILL.md)) — **execute**: does **one** PR end-to-end, then stops. `ship-next "<task>"` is `new-task` + ship in one go.
- **Client adapters** — Claude Code exposes thin `/new-task` and `/ship-next` wrappers; `/loop /ship-next` re-invokes one item at a time. Other clients invoke the canonical skills through their supported skill and delegation mechanisms.
- **haven-reviewer** — the per-PR quality gate.
- **Docs acceptance gate** — `docs:check` and `docs:test` are **CI required checks** on every PR ([#1023](https://github.com/d-hinders/Haven-AI/issues/1023) — the *Docs front-matter & agent skills* job), so a PR with invalid front-matter or an unresolved `covers:` glob cannot reach auto-merge no matter how it was opened. `ship-next` still runs them locally before pushing, but only to save a round trip — it is no longer the thing that enforces them. Same shape for **Design-system coupling (strict)**.
- **haven-doc-reviewer** — per-PR check that the docs describing the changed code are still accurate (see `docs/contributing/docs-quality-system.md`). When the diff touches code that some doc's `covers:` front-matter maps to, running it is a **hard definition-of-done step in the loop**: `ship-next` must review those docs and, in the same PR, update the stale claims (or genuinely re-verify and bump `last-verified`) before opening the PR. This is a loop requirement enforced by the skill, independent of GitHub required-checks — the **docs↔code** coupling comment (`docs-coupling.yml`) stays advisory and does not by itself block auto-merge, except for docs marked `contract: true`. (Not to be confused with the *design-system* coupling gate one bullet up, which does block.)
- **Surface playbooks** — `ship-next` classifies each issue's surface from its `area:*` / `money-path` labels and loads the matching playbook from `docs/contributing/ship-playbooks/` (UX + design system for frontend, CASP for money-path, etc.), so the right standards apply without a long prompt. See [`ship-playbooks/README.md`](ship-playbooks/README.md).
- **`.github/CODEOWNERS`** — the migration carve-out for independent GitHub review and merge.

> **Base branch: `dev`, not `main`.** The loop branches off `dev` and opens every
> PR with base `dev`. The `dev-gate` workflow (`.github/workflows/dev-gate.yml`)
> only lets `dev` or `hotfix/*` merge into `main`, so feature branches can
> never target `main` directly — they would fail the gate. Feature work uses
> the active client's required branch prefix and flows into `dev`; promoting
> `dev → main` (which deploys to prod) is a separate,
> human step.
>
> **`dev` is the repo's default branch**, so `Closes #<n>` closes the issue on the
> **dev-merge** — closed = implemented and on dev. The converse does not hold:
> a PR shipped in ship-next's *operator-verify mode* writes `Refs #<n>` instead,
> precisely so the issue survives the merge while a human still has an outstanding
> live step, so an OPEN issue can already be implemented and on `dev` (#2276). What's actually in **prod** is
> tracked separately (issue state is not overloaded with promotion state): each
> `dev → main` promotion cuts a **prod GitHub Release** (`.github/workflows/release.yml`)
> with auto-generated notes, and the **pending-promotion digest**
> (`.github/workflows/promotion-digest.yml`) keeps a single pinned "📦 Pending
> promotion" issue listing what's on `dev` but not yet in prod — refreshed on
> every promotion and weekly. The `main..dev` compare is the same view on demand. Full details: [`branch-and-release-flow.md`](branch-and-release-flow.md).

## Quickstart

The examples below use the Claude Code slash-command adapter. In a compatible
client, invoke the canonical `new-task` or `ship-next` skill with the same
arguments. Repetition is client-specific; every `ship-next` run handles one
issue and stops.

```bash
# Capture a task as a well-formed backlog issue (does NOT ship it):
/new-task "add a copy button to the agent card"

# Throw a task straight at the loop — drafts the issue AND ships it:
/ship-next "add a copy button to the agent card"

# Standalone small tasks — open issues labeled `code-quality` are the queue:
/loop /ship-next                 # default source = the `code-quality` label
/loop /ship-next label=<label>   # or any other loop label you've set up

# A GitHub epic — its open sub-issues become the queue:
/loop /ship-next epic=#<n>

# One PR at a time, to watch it before handing over the whole queue:
/ship-next
```

Then leave it running: it opens PRs, auto-merges the safe ones on green CI, and
pings you only for a real decision, a blocking review finding, a live work
overlap, or stuck CI.


## Feeding work in

The queue is always **GitHub issues** — nothing is tracked in the repo. Issue
state *is* the backlog state: an open issue with no PR and no live claim or work
overlap is ready, an open issue with an open Haven PR is in flight, and a closed
issue is done (its PR closed it via `Closes #`). One deliberate exception, and it
reads as ready when it is not: an issue labelled **`operator-verify`** has merged
code and is waiting on a human step, so its PR wrote `Refs #<n>` and the merge left
it open (#2276).

You don't have to hand-write those issues. **Capture is its own step:**
[`new-task "<description>"`](../../.agents/skills/new-task/SKILL.md) turns a one-line
task into a well-formed issue (Scope + Acceptance + Surface + Money-path), asking
a clarifying question or two when needed. It's **backlog-only by default** — it
applies `area:*` labels but *not* `code-quality`, so capturing a task doesn't
queue it. Promote it later by adding `code-quality`, or skip straight to shipping
with `ship-next "<description>"` (drafts the issue *and* runs the pipeline). This
is the low-friction front door for partners: throw a sentence, the system does
the paperwork. Then the loop consumes those issues one of these ways:

1. **Standalone labeled issues** — for small, self-contained tasks. Open an issue
   with a concrete **scope + acceptance criteria** and add the **`code-quality`**
   label (the loop's default "ready" marker). The "🔁 Loop task" issue template
   (`.github/ISSUE_TEMPLATE/`) prompts for the fields the loop needs and applies
   the label for you. Run `/loop /ship-next` (or `label=<name>` for a different
   loop label); the loop takes them oldest-first.

2. **A GitHub epic + sub-issues** — for a multi-PR plan that should burn down
   together. Open a parent (epic) issue with well-scoped **sub-issues**, then run
   `/loop /ship-next epic=#<n>`. The epic's **open sub-issues** are the queue,
   lowest number first. (Drive an epic via `epic=#n`; you don't also need to put
   the `code-quality` label on its sub-issues — that's for the standalone queue.)

Either way, each PR includes `Closes #<n>`, so merging closes the issue and
GitHub stays the source of truth — there is no file to maintain. The only
requirement: an issue must be defined well enough to implement — one with no
acceptance criteria makes the loop stop and ask you to sharpen it.

**The one exception is `operator-verify` mode (#2276).** When the definition of
done includes a step only a human can run — a vendor dashboard, funded mainnet
keys, a live end-to-end run — the code half ships and the issue must stay OPEN.
`Closes` is a GitHub keyword, so writing "this issue stays open" in the body does
not survive the merge: #2268 said so three times, in the issue, in its release
comment and in PR #2272's own body, and the merge closed it anyway. Such a PR
writes **`Refs #<n>`** and the issue carries the **`operator-verify`** label. That
is enforced, not merely conventional — `scripts/ci/operator-verify-close-guard.mjs`
runs inside the required *Docs front-matter & agent skills* check and fails a pull
request whose closing keyword targets a labelled issue, or one the pull request
itself says stays open.

**The keyword counts wherever its text reaches `dev` (#2320)** — the body, every
commit message on the pull request (a merge commit lands them verbatim; a squash
lands them concatenated), and the title via the squash subject. The guard reads
all three, after PR #2314 — whose body closed only its own issue, #2276, and was
never at fault — closed #2268 anyway from a commit message that only *described*
the incident. Two consequences worth
stating: a code fence or blockquote is **not** an escape — a fenced keyword in a
commit message is what closed #2268 the second time, and the guard treats a fenced
keyword in the body the same way — and the way to write about it is a form GitHub
does not parse
(`Refs #<n>`, a non-numeric placeholder, or the number with no keyword before it).
The narrower half of the same fix (#2327): the guard's stays-open signal now reads
only assertions about the issue's post-merge **state**, so a body declaring that
operator-verify mode does **not** apply no longer fails the check.

**Every keyword in this document is quoted, never emitted — write yours bare
(#2382).** The code spans around `Closes #<n>` and `Refs #<n>` above are this
file writing *about* the keyword, in the unparsed form the paragraph above
requires. Substituting a real number for the placeholder carries the code span
across with it, and that is not the same string: GitHub's body parse respects
Markdown rendering, so a keyword inside a code span in a pull-request **body** is
not parsed at all. Measured on PR #2364 — backticked body, empty
`closingIssuesReferences`, nothing linked at the merge, and #2361 closed by hand
109 seconds later. The keyword you actually emit is bare, in the body, the
pull-request title and the commit messages alike; the pull-request template's
Issue Link placeholders are bare for the same reason.

You can run a single step manually with `ship-next` (without a client loop) to watch one
PR go through before handing it the whole queue.

## Merge policy A (what this loop does)

**Reviewer-gated auto-merge:**
- A **non-money-path** PR (docs, tests, mechanical refactor, other code)
  auto-merges (squash) when **CI is green** *and* **haven-reviewer returned no
  blocking/should-fix findings**. For a **frontend (`area:frontend`)** PR there is
  one addition (see [`ship-playbooks/frontend.md`](ship-playbooks/frontend.md)):
  if the design-review / haven-reviewer UI pass flags a UX, copy, or
  design-system issue (even a nit-level one), the loop **pauses** even if CI is
  green. Clearing that pause is the reviewer's call, not the user's (#1968) —
  fix, re-capture the screenshots, re-run the pass that raised it, and a clean
  re-review re-arms auto-merge unattended. It escalates to the user only when
  the re-review raises a NEW finding, when the finding is deferred or disputed
  rather than fixed, or when there is no re-review at all.
- Auto-merge is not armed at all until the PR body carries a **named verdict
  line for each review pass** — `haven-reviewer: passed | skipped because ___`
  (#1968). A filled skip proceeds; a blank one does not. The loop's whole safety
  claim below is "CI + haven-reviewer", and a silently skipped pass is that
  claim being false with nothing to read it off.
- A **money-path** PR (x402 / payments / machine-payments / payment-coverage /
  allowance-module / agentAuth / release tooling) auto-merges on the same terms
  (#1024). The label still selects `money.md` and its characterization-test
  bar; it no longer pauses the merge. See "Money-path safety model" below for
  what replaced the pause, **and for what that replacement does not cover**.
- A **DB-migration** PR (`db/migrations/`) additionally needs an **independent
  code-owner approval in GitHub** — it's the one class still hard-gated by
  `.github/CODEOWNERS` (migrations are irreversible in prod).
- Auto-merge does not bypass anything: GitHub still requires all configured
  status checks. If CI fails, the merge simply doesn't happen.

## Money-path safety model (read this)

Two gates, both **automatic** and both applying to every PR however it was
opened ([#1024](https://github.com/d-hinders/Haven-AI/issues/1024)):

1. **`.github/CODEOWNERS`** on `/packages/backend/src/db/migrations/` — an
   irreversible schema change needs an approval from a collaborator **other than
   the author** (GitHub's self-approval rule). This is the one hard human gate.
2. **Money-flow QA freshness** (`dev-gate.yml` → the `qa-freshness` job) — a
   `dev → main` promotion is refused unless a green `qa-dev` run exists on `dev`
   inside `QA_FRESHNESS_HOURS` (default 30h).

Verification therefore happens at **promotion time**, enforced by machine —
not at merge time, enforced by a prompt.

### Be precise about what gate 2 proves

Since [#1030](https://github.com/d-hinders/Haven-AI/issues/1030), `qa-freshness`
proves: **a green money-flow run covered the money-path code being promoted.**
That is stronger than the original "some green run exists and is recent", and
the wording matters — an overstated net is worse than a known-partial one,
because nobody compensates for a gap they believe is closed.

What it now checks (`scripts/ci/qa-freshness.mjs`, unit-tested):

- the newest green `qa-dev` run exists and is inside `QA_FRESHNESS_HOURS`
  (default 30h) — the original rule, unchanged;
- **no money-path file changed between that run's commit and the promotion
  head.** Recency is not coverage: a run that predates the money-path commits
  never exercised them. Ordinary promotions carrying no money-path change stay
  cheap;
- **except a money-path file whose whole diff is an in-place release-bump
  version bump** ([#2164](https://github.com/d-hinders/Haven-AI/issues/2164)) —
  three line shapes only, *every* changed line must match one, **and** within
  each hunk the symbols removed must be exactly the symbols added. That second
  condition is load-bearing: shape matching alone excused a constant deletion, a
  dependency identity swap and a constant rename, because it asks whether lines
  are version-*shaped* rather than whether the diff is a version *bump* — and
  checking it per hunk rather than file-wide is what refuses a dependency moved
  between sections, which nets to zero symbols across the file. A
  behavioural change travelling in the same commit as a bump still blocks. This
  is a genuine narrowing of the net and is named here for that reason: without
  it every release promotion failed by construction, because the bump rewrites
  `SIGNER_VERSION` into `packages/signer/**` after the last green run, and
  `qa-override` became the standing route past the gate on exactly the
  promotions that ship new signing code. `docs/operations/agent-qa.md`
  § *Automation & gating* has the shapes and the reasoning;
- **A money-path `hotfix/* → main` BLOCKS.** It cannot be verified
  automatically and the gate refuses to pretend otherwise: `qa-dev.yml` is a
  black-box harness against a **deployed** backend, and a hotfix is deployed
  nowhere until it merges — so a green run on *any* branch exercised different
  code. Promoting one is an explicit human decision: `qa-override` **with a
  comment stating what was verified**. The label emits a warning and is the
  audit record. A hotfix touching no money-path file passes; this gate does not
  apply to it.

  > This replaced a weaker first attempt that accepted "a green run exists on
  > the hotfix branch". Review caught that it would have been the same
  > unverified pass in a new costume.

Every path that cannot be established fails **closed** — no run, unparseable
timestamp, uncomputable diff, unknown source branch, or a `QA_FRESHNESS_HOURS`
repo variable that is not a positive number (which used to disable the staleness
rule silently while printing a green check). That direction is the whole point.

**Which runs count, and a known limit stated rather than papered over
(#2404):** the gate binds to the QA run's `headSha`, and admits a run only when
its event is `deployment_status`, `schedule` or `workflow_dispatch`, its commit
is an **ancestor of the promotion head** (`git merge-base --is-ancestor` — what
"on dev" was trying to say, and it holds for a run with no branch label), and
its `money-flow` **job** concluded `success` (a run whose `gate` job skipped the
harness still has run-level conclusion `success`). The query used to be
`--branch dev`, which could not see the post-deploy run at all: Railway deploys
a bare SHA, so GitHub records no branch for the `deployment_status` run #2273
fires. For a `schedule` or `workflow_dispatch` run the `headSha` is the branch
tip when the run was *triggered*, not necessarily the SHA deployed to dev — a
lagging or failed dev deploy makes it overstate what was exercised. For a
`deployment_status` run they coincide by construction (`GITHUB_SHA` *is* the
deployed commit), which is why admitting it matters. **Read that as one case
that is live and one that is still only predicted (#2268 → #2273 → #2404):**
the trigger that used to be named here, `repository_dispatch: dev-deployed`,
fired 0 times in 156 runs because Railway offers no place to send it from;
#2273 rebuilt it on GitHub's own `deployment_status` event, which has **not yet
been observed firing** (it runs only the default branch's workflow file, so the
first real deploy after the merge is the evidence — #2268/#2273
operator-verify). The gate's rules hold whichever `headBranch` that first run
turns out to carry. The evidence, the dedupe and the provenance rule that stops
a manual dispatch from impersonating a deploy (#2271) are in
[`agent-qa.md`](../operations/agent-qa.md) § *Post-deploy trigger*. Also,
`git diff
--name-only` reports only a rename's destination path, so renaming a money-path
file *out* of the glob list reads as a non-money-path change.

Still not covered, **deliberately** — these are named, logged escape hatches,
not holes:

- **`qa-override` label** skips the check; the job reports success with a
  `::warning::` naming the bypass.
- **`QA_FRESHNESS_HOURS` is a repo variable**, editable without code review.
- **Direct pushes and admin merges** never evaluate it — it triggers on
  `pull_request` to `main`.
- **It only bites while listed in `main`'s required status checks.**

> **What changed and why.** `ship-next` used to pause a money-path PR for
> in-session user approval. That gate applied *only to PRs opened through the
> loop* — a hand-written money-path PR merged on green CI alone, as
> `CODEOWNERS` recorded at the time. So the pause was friction that made the
> canonical workflow **more expensive than not using it**, with nothing
> compensating on the other path. It was also weak on its own terms: in
> practice the approver was the PR author, which is precisely what GitHub
> disallows in the one place independence is genuinely required.
>
> Removing it deliberately depends on `qa-freshness` being in `main`'s required
> checks. If that check is ever dropped from the ruleset, this model has a hole
> — re-add it, or widen `CODEOWNERS`.

### The window this model does NOT close: merge → dev-deploy

Every gate above sits in front of **prod**. An auto-merged money-path PR
deploys to the **dev environment on merge** and executes real testnet payments
there *before* any promotion gate evaluates anything — and the nightly
`qa-dev` workflow checks out `dev` and runs the qa-agent harness **from that
branch** with the QA payment secrets in env, so an auto-merged malicious
change to qa-agent or the SDK runs with those secrets unseen by any human.
The blast radius is bounded on purpose — the dev backend serves only Base
Sepolia (`HAVEN_DEPLOY_CHAIN_IDS`), relayer keys are per-chain, and every
credential in that environment is a testnet throwaway — but "bounded" is not
"zero": the honest reading is that dev-deploy risk is **accepted**, not
covered.

The #1047 hardening decision, recorded: the `haven_api_url` dispatch input is
now **validated to be an `https://<app>.up.railway.app` origin** (whole-string
match, control characters rejected) and logged with the dispatching actor.
Stated precisely: that constrains the override to *Railway's* deploy surface,
not Haven's — Railway is multi-tenant, so a write-access attacker could still
aim at a Railway app they control; what the check removes is the quiet
arbitrary-endpoint path, and the log names who aimed where. Two residuals are
accepted and named: (a) tightening to an exact-hostname allowlist is the next
step if this risk stops being acceptable; (b) a `workflow_dispatch` on an
arbitrary ref runs *that ref's* copy of `qa-dev.yml` with repo secrets —
inherent to repo-level secrets plus write access; the durable fix is moving
the `QA_*` secrets into a GitHub *environment* restricted to `dev`/`main`. Pinning the harness checkout to a reviewed ref was
**considered and rejected**: the harness must co-evolve with the rail it
proves (a pinned ref goes stale silently, weakening exactly the coverage the
freshness gate certifies), and the compensating control is where it belongs —
on-chain and in scope: every QA credential is a testnet throwaway, the
delegation identity's budget is capped by its own caveat enforcers, and the
dev backend serves Base Sepolia only. If the dev environment ever holds
non-testnet value, that trade-off must be re-taken.

Money-path **classification is unchanged**: `ship-next` still routes such a diff
to `money.md`, still requires characterization tests before changing existing
behavior, and still surfaces the classification in the PR body. It just no
longer blocks the merge on a human saying yes.

## Reviewing a migration PR (for code owners)

DB-migration PRs are the only ones GitHub will request a code-owner review on.
If you're asked to review one:
- It has already passed CI **and** haven-reviewer — your review is the human
  circuit-breaker for an irreversible schema change.
- Confirm the migration is **additive / reversible-in-practice** (no destructive
  `DROP`/`ALTER` of in-use columns without a backfill plan) and that any default
  or constraint change is safe on existing rows.
- The PR body carries the haven-reviewer verdict — skim it, then **approve and
  merge**, or request changes (the loop picks up review comments).

## One-time GitHub setup (required)

Without this, `ship-next` can open PRs but cannot auto-merge them.

1. **Settings → General → Default branch: set to `dev`.** This is what makes
   `Closes #<n>` close issues on the **dev-merge** (closed = implemented). `main`
   stays the protected prod branch (GitFlow-style: prod is a non-default branch).
   Prod promotion is tracked by the release + pending-promotion-digest workflows,
   not by issue state.
2. **Settings → General → Pull Requests:**
   - ☑ **Allow auto-merge** (required, or the auto-merge step is a no-op).
   - ☑ **Automatically delete head branches** (housekeeping).
3. **Settings → Rules → Rulesets** (the repo uses rulesets, not classic branch
   protection). Two active rulesets carry this:
   - **"Haven automerge rules"** (targets **both `main` and `dev`**) — ☑
     **Require a pull request before merging**, ☑ **Block force pushes**, and ☑
     **Require status checks to pass** on **Lint, Type-check & Build**, plus
     **Detect changed surfaces** plus every per-surface quality check: **Backend
     checks**, **Frontend checks**, **SDK checks**, **CLI checks**, **MCP server
     checks**, **MCP checks**, **Connect checks**, **Signer checks** — and the
     blocking design-quality gates **Design visual regression** (#897),
     **Banned product-copy terms** (#902), **Design-system coupling (strict)**
     (#1023), **Docs front-matter & agent skills** (#1023) and
     **Contract-doc coupling** (#646). (Optionally also the smoke checks
     **Install-path smoke** and **Frontend browser smoke**.)
     Do **not** require **Docs links & style (advisory)** — it is the
     deliberately non-gating half of `docs.yml` (#1023).

     > **Fork caveat.** *Banned product-copy terms* and *Contract-doc coupling*
     > carry `if: github.repository == 'd-hinders/Haven-AI'` and therefore
     > **skip on fork PRs**. *Design-system coupling (strict)* deliberately does
     > not — a gate that skips on forks is not a gate. Keep that asymmetry in
     > mind before describing the set as universal.
     These are safe to require even though they're conditional: on a PR that
     doesn't touch a surface, that surface's check reports `skipped`, which GitHub
     counts as satisfied — so requiring all of them gates every surface the loop
     might touch without ever deadlocking. Do **not** require **Vercel Preview
     Comments** — it isn't a quality gate.

     > **A "blocking" CI job only gates auto-merge if it's in this list.** A job
     > that fails its workflow but isn't a required check is advisory in
     > practice: auto-merge fires as soon as the *required* checks are green.
     > This bit for real on 2026-07-13 — *Design visual regression* was red
     > across two auto-merged PRs before anyone noticed, because it wasn't in
     > the ruleset yet. **When a new blocking CI job is added, add it to this
     > ruleset in the same change** (an owner/admin step — agents don't edit
     > rulesets).
     >
     > **And the corollary: a required check's workflow must NOT be
     > `paths:`-filtered.** A paths-filtered workflow never runs — so never
     > reports — on a non-matching PR, and the required check waits forever:
     > auto-merge deadlocks with everything else green (bit the same day on
     > #936, a qa-agent-only PR, when *Banned product-copy terms* was first
     > required — fixed in #937 by dropping the filter). Conditional **jobs
     > inside `ci.yml`** are fine: they always report at least a `skipped`,
     > which GitHub counts as satisfied. Either make the workflow
     > unconditional (fine for ~10s checks) or gate at the job level, never
     > at the workflow `paths:` level.
   - **"Dev gate"** (targets `main` only) — reinforces the pull-request and
     force-push protections on `main`, and carries three additional protections: one
     ruleset rule of its own, plus two required checks from
     `.github/workflows/dev-gate.yml`:
     - **Merge method** ([#2165](https://github.com/d-hinders/Haven-AI/issues/2165)) —
       a pull-request rule with `allowed_merge_methods: ["merge"]`, so a PR based
       on `main` can only be merge-merged; squash and rebase are refused by the
       UI and the API alike. It lives in this ruleset rather than in "Haven
       automerge rules" because that one also targets `dev`, where squash is the
       correct method. `main` therefore carries two pull-request rules whose
       merge-method lists differ, and the effective permission is their
       **intersection** — which GitHub's docs imply under "most restrictive wins"
       but do not state for this field, so it was confirmed empirically on
       throwaway rulesets before the rule was relied on. Why this matters for the
       promotion workflow, and why `hotfix/* → main` is covered too, belong to
       [`branch-and-release-flow.md`](branch-and-release-flow.md) §
       *Promotion to production* — read the reasoning there, not here.
     - **`gate`** — only lets `dev` or `hotfix/*` merge into `main`. This is why
       the loop targets `dev`, never `main`.
     - **`qa-freshness`** — refuses the promotion without a recent green
       money-flow QA run on `dev`. Load-bearing since [#1024](https://github.com/d-hinders/Haven-AI/issues/1024)
       removed the in-session money-path pause; see "Be precise about what gate 2
       proves" above for what it does and does not cover. Note both job ids are
       lower-case (`gate`, `qa-freshness`) because neither job sets a `name:` —
       the workflow's own display name is not the check name.

     This inventory was verified on 2026-08-28 via
     `GET /repos/d-hinders/Haven-AI/rulesets` and
     `GET /repos/d-hinders/Haven-AI/rules/branches/{main,dev}` — the latter is
     the fastest way to re-check the effective branch rules without admin UI
     access. The API reports the pull-request and force-push rules twice on
     `main` (once from each ruleset), **Lint, Type-check & Build** from `Haven
     automerge rules`, and `gate` / `qa-freshness` from `Dev gate` only. The
     **merge-method** rule is narrower by design: `Haven automerge rules` permits
     all three methods, which keeps squash available on `dev`.
   - **Required approvals: 0** at the repo level — this is the hands-off lever.
     Your safety comes from CI + haven-reviewer + the automatic `qa-freshness`
     promotion gate, plus the code-owner gate below for migrations.
   - ☑ **Require review from Code Owners** — keep this on. With the current
     `.github/CODEOWNERS` it bites only **DB migrations** (the one hard-gated
     class); every other path flows on green CI. Widen `.github/CODEOWNERS` if you
     want more paths hard-gated again.
4. **Token/app permissions:** the active GitHub integration or CLI identity needs
   **contents: write, pull_requests: write, issues: write** (issues:write lets
   the loop read epics/labelled issues and close them via `Closes #`). If
   auto-merge calls fail, it's almost always this or step 1.
5. **The loop label:** the standalone queue reads open issues labeled
   **`code-quality`**. Create it once (Issues → Labels → New label, e.g.
   `code-quality`, description "Ready for the autonomous PR loop"). The
   "🔁 Loop task" issue template (`.github/ISSUE_TEMPLATE/loop-task.md`) applies
   it automatically. To run a different queue, use any label via
   `/ship-next label=<name>`.

Tune the carve-out by editing `.github/CODEOWNERS` — widen it to hold more PR
classes for human merge, or narrow it to let more auto-merge.

## Known CI flake signatures

A required check failing with one of these signatures gets **one rerun**
(`gh run rerun <run-id> --failed`) before any diagnosis; a second failure after
the rerun is a real failure. Extend the list only with a signature observed at
least twice.

- **Azure apt-mirror Ign-loop** — browser-dependent jobs on ubuntu runners
  ("Frontend browser smoke", "Design visual regression"): the log shows
  `Ign:N http://azure.archive.ubuntu.com/ubuntu …` repeating until the step
  times out or the job is canceled. apt hangs on the runner's regional mirror;
  nothing in the PR is implicated. Observed repeatedly, most recently twice on 2026-08-19.
- **Base Sepolia RPC flap** — `qa-dev` money-flow legs: transient RPC timeouts
  or stale-nonce reads from the public Base Sepolia endpoint fail a leg that
  passes on rerun. Stability-gate reruns rather than chasing the payment code
  (the 2026-08-12 promotion lesson).

  **#2004 widened where this signature can appear.** The backend test job now
  reaches Base Sepolia too: `non-custody-onchain-enforcer.contract.test.ts` is
  the executable proof of CASP Red Line #4 and `eth_call`s the deployed caveat
  enforcers. It **fails the run** when the endpoint is unreachable in CI rather
  than skipping — a green run that quietly dropped a regulatory proof is the
  worse outcome — so this is the one flake signature that can redden a
  backend-only PR. Its failure message says in words that it is a **transport
  failure, not a policy failure**; read that line before diagnosing, because an
  unreachable RPC says nothing about whether the enforcers refuse an
  out-of-policy redemption. One rerun, as above. If it recurs, point
  `HAVEN_ENFORCER_PROBE_RPC_URL` at a reliable Base Sepolia endpoint rather
  than weakening the gate.
- **`resetDb()`-first backend timeout — FIXED by [#2329](https://github.com/d-hinders/Haven-AI/issues/2329); recorded so nobody re-derives it.**
  *Backend checks* failed with `Error: Test timed out in 5000ms.` in one or more
  real-Postgres tests whose first statement was `await resetDb()` (or
  `await initDbHarness()`), on pull requests that could not have caused it. The
  failing set **shrank and shifted between runs on an unchanged tree**, which is
  what distinguished it from a deterministic break. Two sightings, which is what
  put it on this list: `uuid-param-22p02.test.ts` on
  [#2274](https://github.com/d-hinders/Haven-AI/issues/2274) (one rerun passed),
  and the same file plus `catalog-ingest-lock.test.ts` on
  [#2295](https://github.com/d-hinders/Haven-AI/issues/2295)'s run — where the
  rerun's failing set shrank from three cases to one.

  **The mechanism, so a lookalike can be told apart from it.** It was never a
  test getting slower in proportion to suite load: `collect` was flat and the
  file count identical at 223. It was a **fixed wall applied to the wrong
  budget**. `resetDb()` brings the vitest
  worker's schema to the migration head and serialises that run across workers
  on one advisory lock — a cost that grows with the migration count and, under
  CI contention, with the runs queued ahead of it. `vitest.config.ts` budgets
  exactly that with `hookTimeout: 120_000` (#1372), and that budget applies
  **only to a call made from `beforeAll`/`beforeEach`**. The same call as the
  first statement of an `it` body is charged to vitest's 5000 ms `testTimeout`.
  On #2295's runner one bare `resetDb()` measured **4634 ms against that 5000
  ms**, versus **1162 ms** on green `dev`. Counted against `dev` with the
  TypeScript AST: 47 backend test files call the harness from a hook and could
  never trip the per-test budget; of the seven that call it from a test body,
  four are warmed by a hook of their own and one declares an explicit timeout.
  That left exactly two unbudgeted — and they were exactly the two that failed.

  **The fix was not a bigger number.** Raising `testTimeout` was rejected: the
  cold path's worst case is a migration run plus every queued worker's run ahead
  of it, which is why the harness's own lock deadline is deliberately *larger*
  than `hookTimeout` — any value big enough to cover it is a value at which the
  per-test timeout no longer detects a hung test, applied to all 223 files to
  protect two call sites. Instead the two call sites moved into hooks, where the
  existing budget already covers them;
  `packages/backend/src/infra/__tests__/helpers/__tests__/harness-call-budget.test.ts`
  now fails CI on a new unbudgeted one; and a slow harness call announces itself
  at 2000 ms — *before* the 5000 ms timeout could fire — naming the reset rather
  than whichever test drew the short straw.

  **So this signature should not recur, and a recurrence is not a rerun
  candidate.** If you see `Test timed out in 5000ms` on a real-DB test again,
  look in the log for the `db-harness:` line first: if it is there, the harness
  was the cause and something is genuinely slow (or a new call site slipped
  past the guard); if it is not, the test itself is slow and the rerun-once
  policy does not apply.

## What stays manual (by design)

- Deciding what to build — defining a well-scoped task or epic sub-issue — once. (Writing the issue text itself is automatable via `new-task`; deciding *which* work to queue is the human call.)
- Answering when haven-reviewer flags something **blocking/ambiguous**, or a
  genuine product/architecture/security decision comes up.
- **Code-owner-reviewing migration PRs** in GitHub (the one hard gate), and
  **promoting `dev → main`**, which is where money-path verification now lands.
- Unblocking CI the loop can't fix after a couple of attempts.

## Constraints to know

- **Sequential.** Each item branches off `dev`, so the loop waits for the
  prior PR to merge before starting the next. Wall-clock ≈ sum of CI times.
  A migration awaiting code-owner merge **pauses** the loop (later items build
  on it). Merge it, or tell the loop to skip ahead, to resume.
- **Session lifetime.** A self-paced loop lives only while the session is
  running. Webhooks wake it on CI *failures* and review comments, but **not** on
  CI *success* or the merge itself, so between PRs it polls PR state. For a long
  backlog, keep the session open (or schedule check-ins). It's hands-off on
  *input*, not on *session uptime*.
- **Money paths are never guessed.** Characterization-first is mandatory for any
  change to existing money-path behavior. Since #1024 that requirement is
  backstopped by the reviewer pass rather than by a human seeing the PR before
  merge — a real reduction in independence, accepted knowingly.
