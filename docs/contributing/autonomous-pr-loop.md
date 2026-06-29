---
owner: "@d-hinders"
status: current
covers:
  - .github/CODEOWNERS
  - .github/workflows/dev-gate.yml
  - .github/ISSUE_TEMPLATE/loop-task.md
  - .github/ISSUE_TEMPLATE/loop-epic.md
  - .claude/commands/ship-next.md
last-verified: "2026-06-29"
---

# Autonomous PR loop

**In one line:** hand the loop a list of PRs — as **GitHub issues** (a labeled
standalone task, or an epic's sub-issues) — and it implements, tests, reviews,
opens, and auto-merges them, stopping for a human only on a money-path change, a
real decision, or stuck CI.

> **The backlog is GitHub Issues, not a repo file.** Backlogs used to live in
> `docs/backlogs/*.yml`, but with the `dev`/`main` split a committed status file
> drifts out of sync between branches and has to be hand-reconciled. Issues live
> outside git — one source of truth for humans and the loop, on every branch.
> The old YAML tracks have been retired (see `docs/backlogs/README.md`).

Ship a defined set of PRs with minimal human input. You define the work; the
loop implements, tests, reviews, opens, and (for safe PRs) merges each one —
and only comes back to you for a real decision, a money-path approval, or stuck
CI.

Pieces:
- **`/ship-next`** (`.claude/commands/ship-next.md`) — does **one** PR end-to-end, then stops.
- **`/loop /ship-next`** — re-invokes `/ship-next` for each following item until the backlog is empty (self-paced).
- **haven-reviewer** — the per-PR quality gate.
- **haven-doc-reviewer** — advisory per-PR check that the docs describing the changed code are still accurate (see `docs/contributing/docs-quality-system.md`). Run it when the diff touches code that some doc's `covers:` front-matter maps to; updating those docs is part of definition-of-done. Advisory today — it does not block auto-merge.
- **Surface playbooks** — `/ship-next` classifies each issue's surface from its `area:*` / `money-path` labels (Phase 1.5) and loads the matching playbook from `docs/contributing/ship-playbooks/` (UX + design system for frontend, CASP for money-path, etc.), so the right standards apply without a long prompt. See [`ship-playbooks/README.md`](ship-playbooks/README.md).
- **`.github/CODEOWNERS`** — the money-path carve-out (the only PRs that still need a human merge).

> **Base branch: `dev`, not `main`.** The loop branches off `dev` and opens every
> PR with base `dev`. The `dev-gate` workflow (`.github/workflows/dev-gate.yml`)
> only lets `dev` or `hotfix/*` merge into `main`, so a `claude/*` branch can
> never target `main` directly — it would fail the gate. Feature work flows
> `claude/* → dev`; promoting `dev → main` (which deploys to prod) is a separate,
> human step.
>
> **`dev` is the repo's default branch**, so `Closes #<n>` closes the issue on the
> **dev-merge** — closed = implemented and on dev. What's actually in **prod** is
> tracked separately (issue state is not overloaded with promotion state): each
> `dev → main` promotion cuts a **prod GitHub Release** (`.github/workflows/release.yml`)
> with auto-generated notes, and a weekly **pending-promotion digest**
> (`.github/workflows/promotion-digest.yml`) keeps a "📦 Pending promotion" issue
> listing what's on `dev` but not yet in prod. The `main...dev` compare is the
> same view on demand.

## Quickstart

```bash
# Standalone small tasks — open issues labeled `code-quality` are the queue:
/loop /ship-next                 # default source = the `code-quality` label
/loop /ship-next label=<label>   # or any other loop label you've set up

# A GitHub epic — its open sub-issues become the queue:
/loop /ship-next epic=#<n>

# One PR at a time, to watch it before handing over the whole queue:
/ship-next
```

Then leave it running: it opens PRs, auto-merges the safe ones on green CI, and
pings you only for a money-path approval, a real decision, or stuck CI.


## Two ways to feed work in

Both are **GitHub issues** — nothing is tracked in the repo. Issue state *is* the
backlog state: an open issue with no PR is ready, an open issue with an open
Haven PR is in flight, and a closed issue is done (its PR closed it via
`Closes #`).

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

You can run a single step manually with `/ship-next` (no `/loop`) to watch one
PR go through before handing it the whole queue.

## Merge policy A (what this loop does)

**Reviewer-gated auto-merge, with an in-session money-path checkpoint:**
- A **non-money-path** PR (docs, tests, mechanical refactor, other code)
  auto-merges (squash) when **CI is green** *and* **haven-reviewer returned no
  blocking/should-fix findings**. For a **frontend (`area:frontend`)** PR there is
  one addition (see [`ship-playbooks/frontend.md`](ship-playbooks/frontend.md)):
  if the design-review / haven-reviewer UI pass flags a UX, copy, or
  design-system issue (even a nit-level one), the loop **pauses for the user**
  even if CI is green — UX is a human call.
- A **money-path** PR (x402 / payments / machine-payments / payment-coverage /
  allowance-module / agentAuth / release tooling) does **not** auto-merge
  silently — the loop **pauses and asks whoever is running it to approve**
  in-session, then merges on approval. This is the human checkpoint for money
  movement.
- A **DB-migration** PR (`db/migrations/`) additionally needs an **independent
  code-owner approval in GitHub** — it's the one class still hard-gated by
  `.github/CODEOWNERS` (migrations are irreversible in prod).
- Auto-merge does not bypass anything: GitHub still requires all configured
  status checks. If CI fails, the merge simply doesn't happen.

## Money-path safety model (read this)

The gate for most money-path changes is a **soft, in-session checkpoint**, not a
hard GitHub rule. Two consequences to be aware of:
- It's a **self-approval**: the person running the loop approves the change —
  there's no independent second reviewer (except for migrations, see above).
- It **only covers PRs made through the loop.** A money-path PR created *outside*
  the loop (a hand-written PR, another agent) merges on green CI alone — there is
  no human gate on it. This is the deliberate trade-off for low contributor
  friction at this stage; widen `.github/CODEOWNERS` if you want a hard gate back
  on more paths.

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

Without this, `/ship-next` can open PRs but cannot auto-merge them.

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
     checks**, **MCP checks**, **Connect checks**, **Signer checks**. (Optionally
     also the smoke checks **Install-path smoke** and **Frontend browser smoke**.)
     These are safe to require even though they're conditional: on a PR that
     doesn't touch a surface, that surface's check reports `skipped`, which GitHub
     counts as satisfied — so requiring all of them gates every surface the loop
     might touch without ever deadlocking. Do **not** require **Vercel Preview
     Comments** — it isn't a quality gate.
   - **"Dev gate"** (targets `main` only) — enforces the **`gate`** check from
     `.github/workflows/dev-gate.yml`, which only lets `dev` or `hotfix/*` merge
     into `main`. This is why the loop targets `dev`, never `main`.
   - **Required approvals: 0** at the repo level — this is the hands-off lever.
     Your safety comes from CI + haven-reviewer + the loop's in-session money-path
     checkpoint, plus the code-owner gate below for migrations.
   - ☑ **Require review from Code Owners** — keep this on. With the current
     `.github/CODEOWNERS` it bites only **DB migrations** (the one hard-gated
     class); every other path flows on green CI. Widen `.github/CODEOWNERS` if you
     want more paths hard-gated again.
4. **Token/app permissions:** the Claude GitHub integration for this repo needs
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

- Defining the work as issues — a well-scoped labeled task or epic sub-issue — once.
- Answering when haven-reviewer flags something **blocking/ambiguous**, or a
  genuine product/architecture/security decision comes up.
- **Approving money-path PRs in-session** when the loop pauses for them, and
  **code-owner-reviewing migration PRs** in GitHub (the one hard gate).
- Unblocking CI the loop can't fix after a couple of attempts.

## Constraints to know

- **Sequential.** Each item branches off `dev`, so the loop waits for the
  prior PR to merge before starting the next. Wall-clock ≈ sum of CI times.
  A money-path PR awaiting your merge **pauses** the loop (later items build on
  it) — merge it (or tell the loop to skip ahead) to resume.
- **Session lifetime.** A self-paced loop lives only while the session is
  running. Webhooks wake it on CI *failures* and review comments, but **not** on
  CI *success* or the merge itself, so between PRs it polls PR state. For a long
  backlog, keep the session open (or schedule check-ins). It's hands-off on
  *input*, not on *session uptime*.
- **Money paths are never guessed.** Characterization-first is mandatory for any
  change to existing money-path behavior, and those PRs always route to you.
