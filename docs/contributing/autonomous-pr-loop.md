# Autonomous PR loop

Ship a defined set of PRs with minimal human input. You define the work; the
loop implements, tests, reviews, opens, and (for safe PRs) merges each one —
and only comes back to you for a real decision, a money-path approval, or stuck
CI.

Pieces:
- **`/ship-next`** (`.claude/commands/ship-next.md`) — does **one** PR end-to-end, then stops.
- **`/loop /ship-next`** — re-invokes `/ship-next` for each following item until the backlog is empty (self-paced).
- **haven-reviewer** — the per-PR quality gate.
- **`.github/CODEOWNERS`** — the money-path carve-out (the only PRs that still need your merge).

## Two ways to feed work in

1. **Backlog file** — for self-defined tracks (e.g. code-quality). Copy
   `docs/backlogs/_template.yml` to `docs/backlogs/<track>.yml`, fill in `items`
   (each with a concrete `scope` + acceptance criteria), then run
   `/loop /ship-next docs/backlogs/<track>.yml`.

2. **A GitHub epic + sub-issues** — for pre-defined epics. Run
   `/loop /ship-next epic=#<n>`. The epic's **open sub-issues** are the queue;
   each PR includes `Closes #<sub-issue>`, so merging burns the epic down and
   GitHub is the source of truth (no file to maintain). The only requirement:
   sub-issues must be defined well enough to implement — a sub-issue with no
   acceptance criteria makes the loop stop and ask you to sharpen it.

You can run a single step manually with `/ship-next` (no `/loop`) to watch one
PR go through before handing it the whole backlog.

## Merge policy A (what this loop does)

**Reviewer-gated auto-merge with a money-path carve-out:**
- A PR auto-merges (squash) only when **CI is green** *and* **haven-reviewer
  returned no blocking/should-fix findings** *and* it does **not** touch a
  CODEOWNERS-owned path.
- PRs touching money-path / auth / migration / release paths
  (`.github/CODEOWNERS`) **never auto-merge** — they wait for your review+merge.
- Auto-merge does not bypass anything: GitHub still requires all configured
  status checks. If CI fails, the merge simply doesn't happen.

## One-time GitHub setup (required)

Without this, `/ship-next` can open PRs but cannot auto-merge them.

1. **Settings → General → Pull Requests:**
   - ☑ **Allow auto-merge** (required, or the auto-merge step is a no-op).
   - ☑ **Automatically delete head branches** (housekeeping).
2. **Settings → Branches → rule for `main`** (or a Ruleset):
   - ☑ **Require a pull request before merging.**
   - ☑ **Require status checks to pass** → require **Detect changed surfaces**
     plus every per-surface quality check: **Backend checks**, **Frontend
     checks**, **SDK checks**, **MCP server checks**, **MCP checks**, **Connect
     checks**, **Signer checks**. (Optionally also the smoke checks **Install-path
     smoke** and **Frontend browser smoke**.) These are safe to require even
     though they're conditional: on a PR that doesn't touch a surface, that
     surface's check reports `skipped`, which GitHub counts as satisfied — so
     requiring all of them gates every surface the loop might touch without ever
     deadlocking. Do **not** require **Vercel Preview Comments** — it isn't a
     quality gate.
   - **Required approvals: 0** at the repo level — this is the hands-off lever.
     Your safety comes from CI + haven-reviewer + the CODEOWNERS carve-out.
   - ☑ **Require review from Code Owners** — this is what makes the carve-out
     bite: only PRs touching `.github/CODEOWNERS` paths need your approval;
     everything else flows on green CI.
3. **Token/app permissions:** the Claude GitHub integration for this repo needs
   **contents: write, pull_requests: write, issues: write** (issues:write lets
   the loop read epics and close sub-issues). If auto-merge calls fail, it's
   almost always this or step 1.

Tune the carve-out by editing `.github/CODEOWNERS` — widen it to hold more PR
classes for human merge, or narrow it to let more auto-merge.

## What stays manual (by design)

- Defining/approving the backlog (or writing well-scoped epic sub-issues) — once.
- Answering when haven-reviewer flags something **blocking/ambiguous**, or a
  genuine product/architecture/security decision comes up.
- **Merging money-path PRs** (the CODEOWNERS carve-out).
- Unblocking CI the loop can't fix after a couple of attempts.

## Constraints to know

- **Sequential.** Each item branches off `main`, so the loop waits for the
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
