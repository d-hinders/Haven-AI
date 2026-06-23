---
description: "Autonomous PR loop (policy A): take the next item from a backlog file or a GitHub epic's sub-issues, implement it on a branch, gate it through tests + haven-reviewer, open a PR, and reviewer-gated auto-merge it — escalating to the user only on a blocking finding, a real decision, or stuck CI. Designed to be driven by /loop."
---

Ship the **next single item** of defined work end-to-end, then stop. `/loop` re-invokes this for the following item, so each run handles exactly one PR.

Argument (optional): a backlog source.
- `docs/backlogs/<track>.yml` — a repo backlog file (default: the most recently modified file in `docs/backlogs/` whose status is not all-merged).
- `epic=#<n>` — a GitHub epic (parent issue); its **open sub-issues** are the queue.
If no argument is given, look for an in-progress `docs/backlogs/*.yml`; if none, ask the user which source to use and stop.

This command implements **merge policy A**: reviewer-gated auto-merge, with a money-path carve-out enforced by `.github/CODEOWNERS`. See `docs/contributing/autonomous-pr-loop.md`.

## Phase 0 — Serialize (never run two open PRs from one backlog)

1. If the backlog has an item in state `in-pr` (or, for an epic, a sub-issue with an open Haven PR), check that PR:
   - **Merged** → mark the item `merged` (file mode) and continue to Phase 1.
   - **Open, awaiting the user** (a money-path PR needing CODEOWNERS approval, or an escalation) → **stop** and report: this item is blocked on the user; do not start the next item (later items branch off `dev` and must build on the merged one).
   - **Open, CI still running / fixable failure** → handle it (re-run, fix, push) but do not start a new item.
2. Only when there is no open in-flight item do you pick the next `todo`.

## Phase 1 — Pick the next item

3. File mode: first item with `status: todo`. Epic mode: lowest-numbered **open** sub-issue not yet covered by an open/merged Haven PR.
4. If the item's scope/acceptance is too vague to implement safely (especially an epic sub-issue with no acceptance criteria), **stop and ask the user** to sharpen it. A vague money-path item is never guessed at.
5. Sync and branch off fresh `dev` (the integration branch — **not** `main`):
   - `git fetch origin dev && git checkout -B claude/<track>-<item-id> origin/dev`
   - The loop targets `dev` because the `dev-gate` workflow (`.github/workflows/dev-gate.yml`) only allows `dev` or `hotfix/*` into `main`; a `claude/*` branch can never merge straight to `main`. Feature work flows `claude/* → dev`, and `dev → main` is promoted separately.

## Phase 2 — Implement

6. Implement only this item's scope. If the change alters existing behavior of a money path (`x402`, `machine-payments`, `payment-coverage`, allowance/coverage decisions, migrations), **write characterization tests first** (pin current behavior), then change.
7. Match surrounding code conventions. Keep the diff to the item's owned files where possible.

## Phase 3 — Acceptance gate (hard gate — never push red)

8. Run the gate for the affected workspace(s):
   - Tests: `npm run test -w packages/<pkg>` (or `npx vitest run` in that package).
   - Types: `npm run typecheck -w packages/<pkg>` (`tsc --noEmit`).
   - For cross-package changes, run the full `npm run quality` (typecheck + test:unit + build).
9. If anything is red, fix it. Do not proceed to a PR with a red gate.

## Phase 4 — Review (haven-reviewer)

10. Launch the **haven-reviewer** subagent on the diff (`git diff origin/dev...HEAD`), with the item's scope and the invariants it must preserve.
11. Triage findings:
    - **blocking / should-fix** that are clearly correct and small → apply them, re-run the gate.
    - **blocking / should-fix that are ambiguous, architectural, or change product behavior** → **stop and ask the user** (use AskUserQuestion with enough context to answer without scrolling). Do not guess on money movement, auth, or schema.
    - **nice-to-have / nits** → apply if cheap; otherwise note in the PR body and skip.
12. Record in the commit/PR which findings were applied and which were deferred (with reasons), as in this session's PRs.

## Phase 5 — Open the PR

13. Commit with a conventional message (end with the Co-Authored-By / Claude-Session trailers per the repo convention). Push `-u origin <branch>`.
14. Open the PR via `mcp__github__create_pull_request` with **base `dev`** (never `main`). Body: scope, the behavior-preservation argument, verification output (test counts, tsc), and reviewer outcome. For **epic** items, include `Closes #<sub-issue>` so the epic burns down automatically.
15. `subscribe_pr_activity` for the PR so CI failures / review comments wake the loop.

## Phase 6 — Merge gate (policy A: in-session money-path approval; migrations hard-gated)

A path is **money-path** if it matches any of: `routes/x402.ts`,
`routes/x402-resources.ts`, `routes/payments.ts`, `routes/machine-payments.ts`,
`lib/machine-payments.ts`, `lib/payment-coverage.ts`, `lib/allowance-module.ts`,
`middleware/agentAuth.ts`, `db/migrations/`, or release tooling
(`scripts/release-bump.mjs`, `.github/workflows/publish.yml`).

16. Route the merge by class:
    - **Non-money-path** (docs, tests, mechanical refactor, other code): if the
      acceptance gate passed and haven-reviewer returned **no
      blocking/should-fix**, call `mcp__github__enable_pr_auto_merge` (squash).
      GitHub merges it once required checks pass.
    - **Money-path, NOT a migration:** do **not** auto-merge silently. **Ask the
      person running the loop to approve** with `AskUserQuestion` — include the
      PR link, the scope, and the haven-reviewer verdict so they can decide
      without digging. On **approve** → `enable_pr_auto_merge` (squash). On
      **decline / change requested** → apply the change or leave the PR for
      revision; do not merge. (This is the in-session human checkpoint that
      replaced the CODEOWNERS gate for these paths.)
    - **Migration (`db/migrations/`):** do **not** auto-merge. It is hard-gated
      by `.github/CODEOWNERS` and needs an independent code-owner approval in
      GitHub. Report: "PR #N changes a DB migration — needs a code-owner
      review+merge." Leave it; do not start the next item until it merges.
17. Never bypass a failing required check. If CI fails after auto-merge is armed, the merge won't happen — diagnose, fix, push; re-arm only on green.

## Phase 7 — Update state and stop

18. File mode: set the item to `in-pr` (it becomes `merged` on a later pass once GitHub merges it). Commit the backlog change on the item branch's PR, or on a tiny follow-up — keep the backlog file truthful.
19. Epic mode: the `Closes #` handles it; no file to update.
20. Report a one-line status (item, PR link, gate result, merge mode) and **stop**. Do not begin the next item in the same run.

## When to involve the user (the only times)

- A blocking/ambiguous reviewer finding, or any real product/architecture/security decision.
- A money-path PR (it waits for the user's CODEOWNERS approval by design).
- CI failing in a way you can't resolve after a couple of focused attempts.
- A backlog item too underspecified to implement safely.
Everything else — implement, test, review nits, open PR, auto-merge clean PRs, chain to the next — runs without the user.
