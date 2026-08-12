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
last-verified: "2026-08-12" # #1341: re-verified loop stop and issue-readiness conditions after ship-next gained #1289 active-claim coordination
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
> **dev-merge** — closed = implemented and on dev. What's actually in **prod** is
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
issue is done (its PR closed it via `Closes #`).

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

You can run a single step manually with `ship-next` (without a client loop) to watch one
PR go through before handing it the whole queue.

## Merge policy A (what this loop does)

**Reviewer-gated auto-merge:**
- A **non-money-path** PR (docs, tests, mechanical refactor, other code)
  auto-merges (squash) when **CI is green** *and* **haven-reviewer returned no
  blocking/should-fix findings**. For a **frontend (`area:frontend`)** PR there is
  one addition (see [`ship-playbooks/frontend.md`](ship-playbooks/frontend.md)):
  if the design-review / haven-reviewer UI pass flags a UX, copy, or
  design-system issue (even a nit-level one), the loop **pauses for the user**
  even if CI is green — UX is a human call.
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

**Known limit, stated rather than papered over:** the gate binds to the QA
run's `headSha` — the branch tip when the run was *triggered*, not necessarily
the SHA deployed to dev. For the `repository_dispatch: dev-deployed` trigger
they coincide; for the nightly cron, a lagging or failed dev deploy makes the
run's `headSha` overstate what was actually exercised. Also, `git diff
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
   protection). Three active rulesets carry this, all targeting **both `main` and
   `dev`** unless noted:
   - **"Move fast, just don't break prod by accident"** — ☑ **Require a pull
     request before merging**, ☑ **Block force pushes**, and ☑ **Require status
     checks to pass** on the roll-up check **Lint, Type-check & Build**.
   - **"Haven automerge rules"** — ☑ **Require status checks to pass** on
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
   - **"Dev gate"** (targets `main` only) — enforces two checks from
     `.github/workflows/dev-gate.yml`:
     - **`gate`** — only lets `dev` or `hotfix/*` merge into `main`. This is why
       the loop targets `dev`, never `main`.
     - **`qa-freshness`** — refuses the promotion without a recent green
       money-flow QA run on `dev`. Load-bearing since [#1024](https://github.com/d-hinders/Haven-AI/issues/1024)
       removed the in-session money-path pause; see "Be precise about what gate 2
       proves" above for what it does and does not cover. Note both job ids are
       lower-case (`gate`, `qa-freshness`) because neither job sets a `name:` —
       the workflow's own display name is not the check name.

     Verified present in both rulesets on 2026-07-27 via
     `GET /repos/d-hinders/Haven-AI/rules/branches/{main,dev}` — that endpoint is
     the fastest way to re-check this list without admin UI access.
   - **Required approvals: 0** at the repo level — this is the hands-off lever.
     Your safety comes from CI + haven-reviewer + the loop's in-session money-path
     checkpoint, plus the code-owner gate below for migrations.
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
