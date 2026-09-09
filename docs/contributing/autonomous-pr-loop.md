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
last-verified: "2026-09-08"
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
- **haven-doc-reviewer** — per-PR check that the docs describing the changed code are still accurate (see `docs/contributing/docs-quality-system.md`). Running it after implementation is a **hard definition-of-done step in the loop**, and the docs whose `covers:` front-matter maps to the changed code are the floor of what it reviews, not the scope — the pass derives that from the diff's claims (#2499): `ship-next` must review those docs and, in the same PR, update the stale claims (or genuinely re-verify and bump `last-verified`) before opening the PR. This is a loop requirement enforced by the skill, independent of GitHub required-checks — the **docs↔code** coupling comment (`docs-coupling.yml`) stays advisory and does not by itself block auto-merge, except for docs marked `contract: true`. (Not to be confused with the *design-system* coupling gate one bullet up, which does block.)
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
  if the design-review / haven-reviewer UI pass raises a **`blocking`** or
  **`should-fix`** UX, copy, or design-system finding, the loop **pauses** even if
  CI is green. A **`nit`** does not pause since [#2636](https://github.com/d-hinders/Haven-AI/issues/2636)
  — it is fixed in place when it is a one-line change, or dropped under **Not filed**
  with its screenshot (#2767); the severity table and the reasoning are in that
  playbook, not here.

  Clearing that pause is the reviewer's call, not the user's (#1968) —
  fix, re-capture the screenshots, re-run the pass that raised it, and a clean
  re-review re-arms auto-merge unattended. It escalates to the user only when
  the re-review raises a NEW finding, when the finding is deferred or disputed
  rather than fixed, or when there is no re-review at all.
- Auto-merge is not armed at all until the PR body carries a **named verdict
  line for each review pass, naming the head it reviewed** —
  `haven-reviewer: passed @ <sha> | skipped because ___` (#1968). A filled skip
  proceeds; a blank one does not, and neither does a `passed` with no SHA. The loop's whole safety
  claim below is "CI + haven-reviewer", and a silently skipped pass is that
  claim being false with nothing to read it off.
- A **money-path** PR (x402 / payments / machine-payments / payment-coverage /
  allowance-module / agentAuth / release tooling) auto-merges on the same terms
  (#1024). The label still selects `money.md` and its characterization-test
  bar; it no longer pauses the merge. See "Money-path safety model" below for
  what replaced the pause, **and for what that replacement does not cover**.
- A PR changing a **direct migration implementation file**
  (`db/migrations/*.ts`) additionally needs an **independent code-owner approval
  in GitHub** — it's the one class still hard-gated by `.github/CODEOWNERS`
  (migrations are irreversible in prod; `__tests__/` is not a schema change).
- Auto-merge does not bypass anything: GitHub still requires all configured
  status checks. If CI fails, the merge simply doesn't happen.

**What happens to a finding (#2767).** Every finding a session makes — its own,
a reviewer's, a sweep's, a guard's — ends in one of three dispositions: **fixed in
the PR**, **dropped with a reason** under the PR body's **Not filed** list, or
**filed** only when it clears the five-check filing bar in
[`ship-next` § *Filing bar*](../../.agents/skills/ship-next/SKILL.md#filing-bar-2767)
— the bar is stated there once and not restated here. Filing is not a way to
finish a round: #2767's hand count over the issues API on 2026-09-08 (not
re-derivable from `git log`) was 195 issues filed against 199 PRs merged in the
week to 2026-09-08, 141 of the 195 citing another issue filed the same week, and
the promotion digest now prints the filed-per-closed ratio and the
product share of merges every run so the trend is visible.

## Money-path safety model (read this)

Two gates, both **automatic** and both applying to every PR however it was
opened ([#1024](https://github.com/d-hinders/Haven-AI/issues/1024)):

1. **`.github/CODEOWNERS`** on direct migration implementation files
   (`/packages/backend/src/db/migrations/*.ts`) — an irreversible schema change
   needs an approval from a collaborator **other than the author** (GitHub's
   self-approval rule). Migration tests under `__tests__/` are not production
   schema changes and are outside this gate. This is the one hard human gate.
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
"on dev" was trying to say, stated directly), and
its `money-flow` **job** concluded `success` (a run whose `gate` job skipped the
harness still has run-level conclusion `success`). The query used to be
`--branch dev`. #2404 dropped the filter predicting that the
`deployment_status` run #2273 fires would carry no branch (Railway deploys a
bare SHA); measured, it carries `headBranch = dev` — on deployment 6218620498 (`5d4e849c`, 2026-09-02): runs 33609807445, 33609836970 and 33609965305 all report `headBranch = dev`
([#2427](https://github.com/d-hinders/Haven-AI/issues/2427)). The filter stays
dropped for the real reason: a branch name says nothing about which commit the
harness exercised, and on that deployment `--branch dev --status success
--limit 1` would have handed the gate 33609836970 — a run-level `success`
whose `money-flow` job was skipped. For a `schedule` or `workflow_dispatch` run the `headSha` is the branch
tip when the run was *triggered*, not necessarily the SHA deployed to dev — a
lagging or failed dev deploy makes it overstate what was exercised. For a
`deployment_status` run they coincide by construction (`GITHUB_SHA` *is* the
deployed commit), which is why admitting it matters. **Both legs are now measured (#2268 → #2273 → #2404 → #2427):**
the trigger that used to be named here, `repository_dispatch: dev-deployed`,
fired 0 times in 156 runs because Railway offers no place to send it from;
#2273 rebuilt it on GitHub's own `deployment_status` event, first observed
firing on 2026-09-02 for deployment 6218620498 (`5d4e849c`): the gate skipped
the two `in_progress` runs and admitted the `success` one, whose `money-flow`
job ran (and went red on qa-failure #2411, recorded honestly). All three runs
report `headBranch = dev`; the gate does not read the field on this event. The
evidence, the dedupe and the provenance rule that stops
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

PRs changing direct migration implementation files are the only ones GitHub will
request a code-owner review on. If you're asked to review one:
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
   protection). **Three** active rulesets carry this, and they compose: GitHub
   enforces every ruleset whose target matches the branch, taking the **union**
   of required contexts and of the boolean protections, and the
   **intersection** of allowed merge methods. Read the per-ruleset bullets for
   what each one sets, and the *Effective per branch* table below for what a PR
   actually meets.
   - **"Haven automerge rules"** (targets **both `main` and `dev`**) — ☑
     **Require a pull request before merging**, ☑ **Block force pushes**, and ☑
     **Require status checks to pass** on **15 contexts**: **Lint, Type-check &
     Build**, **Detect changed surfaces** and **Repo CI config checks** — the
     last runs the whole `scripts/ci/*.test.mjs` glob plus the dist-freshness
     self-test and the workspace-pin lint — plus every per-surface quality
     check: **Backend checks**, **Frontend checks**, **SDK checks**, **CLI
     checks**, **MCP server checks**, **MCP checks**, **Connect checks**,
     **Signer checks** — and the blocking gates **Banned product-copy terms**
     (#902), **Design-system coupling (strict)** (#1023), **Docs front-matter &
     agent skills** (#1023) and **Contract-doc coupling** (#646). Do **not**
     require **Docs links & style (advisory)** — it is the deliberately
     non-gating half of `docs.yml` (#1023) — and do **not** require **Vercel
     Preview Comments**, which isn't a quality gate.

     Two settings on this ruleset changed on 2026-09-07 under
     [#2632](https://github.com/d-hinders/Haven-AI/issues/2632)'s owner step O1/O2,
     and both are deliberate:
     - **`strict_required_status_checks_policy` is now `false`** — "require
       branches to be up to date before merging" is **off**. It stays on for
       `main` through *Dev gate* (below), so only `dev` loses it.
     - **Design visual regression is no longer in this list** (#897 put it
       there; O2 moved it to `main`). The `design_visual` job still runs on
       every frontend PR into `dev` — its result is now **advisory** there and
       **blocking** on the promotion.

     Its `pull_request` rule still permits **all three merge methods**, which is
     load-bearing: it targets `main` too, and since merge methods intersect,
     narrowing this ruleset would leave `main` with an empty set and no
     promotion could merge at all. The narrowing for `dev` lives in its own
     ruleset instead.

     > **Fork caveat.** *Banned product-copy terms* and *Contract-doc coupling*
     > carry `if: github.repository == 'd-hinders/Haven-AI'` and therefore
     > **skip on fork PRs**. *Design-system coupling (strict)* deliberately does
     > not — a gate that skips on forks is not a gate. Keep that asymmetry in
     > mind before describing the set as universal.
     These are safe to require even though they're conditional: on a PR that
     doesn't touch a surface, that surface's check reports `skipped`, which GitHub
     counts as satisfied — so requiring all of them gates every surface the loop
     might touch without ever deadlocking.

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
   - **"Dev merge"** (targets `dev` only, added 2026-09-07 by O1) — a single
     `pull_request` rule with `allowed_merge_methods: ["squash"]` and
     `required_approving_review_count: 0`, plus block-deletion and
     block-force-push. **No status checks of its own** — the shared ruleset
     already carries those, and adding them here would be a second copy to
     drift. It exists only because merge methods intersect and *Haven automerge
     rules* cannot be narrowed without taking `main` down with it: squash-only
     on `dev` had to be expressed on a `dev`-only ruleset. (Its "require Copilot
     review" checkbox is ticked and inert while the approval count is zero.)
   - **"Dev gate"** (targets `main` only) — reinforces the pull-request and
     force-push protections on `main`, and carries the strict up-to-date policy,
     one merge-method rule of its own, and **four** required checks:
     - **Strict status checks** — `strict_required_status_checks_policy: true`.
       This is the *only* ruleset still setting it, and it is why `main` stays
       up-to-date-gated after O1 turned the flag off on the shared ruleset. The
       booleans union, so `main` keeps the rule and `dev` loses it.
     - **Merge method** ([#2165](https://github.com/d-hinders/Haven-AI/issues/2165)) —
       a pull-request rule with `allowed_merge_methods: ["merge"]`, so a PR based
       on `main` can only be merge-merged; squash and rebase are refused by the
       UI and the API alike. It lives in this ruleset rather than in "Haven
       automerge rules" because that one also targets `dev`, where squash is the
       correct method. Two rulesets match `main` and two match `dev`, so each
       branch carries two pull-request rules whose merge-method lists differ,
       and the effective permission on each is their
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
     - **Design visual regression** and **Frontend browser smoke** — added
       2026-09-07 by O2. Both are `ci.yml` job display names, and both were
       previously either advisory or (in visual regression's case) a `dev`-PR
       gate. #2632's invariant is that nothing moves from required to advisory
       outright: every check taken off `dev` lands on `main`, where the
       promotion PR is also the npm publish and is therefore the single point
       at which "nothing untested reaches prod" is enforced.
   - **Required approvals: 0** at the repo level — this is the hands-off lever.
     Your safety comes from CI + haven-reviewer + the automatic `qa-freshness`
     promotion gate, plus the code-owner gate below for direct migration
     implementation files.
   - ☑ **Require review from Code Owners** — keep this on. With the current
     `.github/CODEOWNERS` it bites only **direct migration implementation files**
     (the one hard-gated class); every other path, including migration tests,
     flows on green CI. Widen `.github/CODEOWNERS` if you want more paths
     hard-gated again.

   **Effective per branch** (the union/intersection above, applied):

   | | `dev` | `main` |
   |---|---|---|
   | Required contexts | **15** (all from *Haven automerge rules*) | **19** (those 15 + `gate`, `qa-freshness`, Design visual regression, Frontend browser smoke) |
   | Branch must be up to date | **no** | **yes** |
   | Allowed merge method | **squash only** | **merge commit only** |

   **What turning the up-to-date rule off on `dev` does and does not change.** A
   PR reported `BEHIND` — `dev` moved since you branched, with no textual
   conflict — is now **mergeable**, and neither `gh pr update-branch` nor a
   `dev` merge-in is required to unblock it. `DIRTY` still blocks exactly as
   before: a textual conflict must be resolved by merging `dev` in. Merging a
   behind branch never reverts the commits that landed on `dev` in between —
   git merges the branch, it does not replace the tree. What is given up is the
   guarantee that the tree CI tested is the tree that lands: two PRs that are
   individually green can conflict *semantically*, and that lands on `dev` and
   reddens the **push-to-`dev` CI run** (already in `ci.yml`) within about five
   minutes, to be fixed forward. `main` keeps the strict rule, so the promotion
   is still gated on the exact tested tree.

   This inventory was verified on **2026-09-07**, after O1/O2, with:

   ```bash
   for id in $(gh api repos/d-hinders/Haven-AI/rulesets --jq '.[].id'); do
     gh api repos/d-hinders/Haven-AI/rulesets/$id
   done
   gh api repos/d-hinders/Haven-AI/rules/branches/dev
   gh api repos/d-hinders/Haven-AI/rules/branches/main
   ```

   The `rules/branches/{main,dev}` form is the fastest way to re-check the
   effective branch rules without admin UI access: it reports each rule once per
   matching ruleset, which is the union above seen from the other side. Two
   rulesets match each branch, so both report `pull_request`, `deletion` and
   `non_fast_forward` twice; `required_status_checks` comes back **once** on
   `dev` (only *Haven automerge rules* sets it) and **twice** on `main` (that
   ruleset plus *Dev gate*).
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

  **Read the `db-harness:` line's phase, and whether it names a holder (#2354).**
  Since #2354 the announcement says which phase the call is in, and a warm reset
  that waits on a relation lock fails BEFORE the 5000 ms timeout with the
  holder named. Four shapes, four dispositions:

  - `resetDb() has been running 2s in phase "migration head"` — the cold path,
    exactly the #2329 mechanism above.
  - `db-harness: resetDb() gave up after 3000 ms waiting for a relation lock in
    test_wN (phase: …). Held by: pid P (…, idle in transaction, xact 12s,
    "…")` — **not a rerun candidate, and not the test's fault.** Another session
    holds a lock on that worker's tables: in CI that is a transaction some test
    in the same worker left open (the quoted statement says which); locally it
    is usually an orphaned vitest worker from an earlier run with the same
    `VITEST_WORKER_ID` — find it in `pg_stat_activity` by the pid and kill it.
    A rerun that happens to pass only means the holder went away.
  - `… in phase "emptying (N DELETEs)"` with **no** holder line, on a call whose
    `DELETE` batch measures ~5 ms quiet — the machine is saturated. That reports
    on the runner, not the code (the same family as #2319); one rerun, and if
    it recurs, look at what else was running, not at the test.
  - `db-harness: resetDb() could not get a pooled connection (phase: catalog
    read) — pool exhaustion: all DB_POOL_MAX=5 …` (or the announcement in phase
    `acquiring connection`, whose cause line says the same) — **not a rerun
    candidate, and not this test's fault.** Another test in the same worker
    checked out every pooled connection and never released one (a
    `db.connect()` without `release()`, a transaction client kept past its
    test). pg-pool's bare `timeout exceeded when trying to connect` is what this
    wraps; if you see the bare form on a harness call, the harness version has
    regressed. Find the leak — a rerun passes only if the leaking test happens
    not to run first.

  The measurements behind those shapes — the warm reset is flat in workers
  and in tables on the `DELETE` path, its floor is the catalog read, and only
  the `TRUNCATE` fallback (now scoped to a cycle's footprint) scales with both —
  are in `testing-strategy.md` § *A warm reset that loses to contention*.

## What stays manual (by design)

- Deciding what to build — defining a well-scoped task or epic sub-issue — once. (Writing the issue text itself is automatable via `new-task`; deciding *which* work to queue is the human call.)
- Answering when haven-reviewer flags something **blocking/ambiguous**, or a
  genuine product/architecture/security decision comes up.
- **Code-owner-reviewing PRs that change direct migration implementation files**
  in GitHub (the one hard gate), and **promoting `dev → main`**, which is where
  money-path verification now lands.
- Unblocking CI the loop can't fix after a couple of attempts.

## Constraints to know

- **Sequential.** Each item branches off `dev`, so the loop waits for the
  prior PR to merge before starting the next. Wall-clock ≈ sum of CI times.
  A direct migration implementation change awaiting code-owner merge **pauses**
  the loop (later items build on it). Merge it, or tell the loop to skip ahead,
  to resume.
- **Session lifetime.** A self-paced loop lives only while the session is
  running. Webhooks wake it on CI *failures* and review comments, but **not** on
  CI *success* or the merge itself, so between PRs it polls PR state. For a long
  backlog, keep the session open (or schedule check-ins). It's hands-off on
  *input*, not on *session uptime*.
- **Money paths are never guessed.** Characterization-first is mandatory for any
  change to existing money-path behavior. Since #1024 that requirement is
  backstopped by the reviewer pass rather than by a human seeing the PR before
  merge — a real reduction in independence, accepted knowingly.
