---
description: "Autonomous PR loop (policy A): take the next ready GitHub issue — a labeled standalone task or an epic's sub-issue — implement it on a branch, gate it through tests + haven-reviewer, open a PR, and reviewer-gated auto-merge it — escalating to the user only on a blocking finding, a real decision, or stuck CI. Designed to be driven by /loop."
---

Ship the **next single ready issue** end-to-end, then stop. `/loop` re-invokes this for the following item, so each run handles exactly one PR.

The queue is **GitHub Issues** (not a repo file — backlogs are no longer tracked in-tree; see `docs/contributing/autonomous-pr-loop.md`). Argument (optional) selects the source:

- *(no argument)* or `label=<name>` — **standalone labeled issues**: open issues carrying the loop label (default **`code-quality`**), oldest first (lowest issue number). Use this for small, self-contained tasks.
- `epic=#<n>` — an **epic** (parent issue): its **open sub-issues** are the queue, lowest number first. Use this for a multi-PR plan that should burn down together.

Issue state *is* the backlog state — there is nothing to edit in the repo:
- **open issue, no linked PR** → ready (a candidate to pick).
- **open issue, linked open Haven PR** → in flight (handled in Phase 0).
- **closed issue** → done (its PR merged with `Closes #`).

If both a `label` queue and an `epic` are in play, run them as separate invocations; a single run draws from exactly one source. If the selected source has no ready issue and nothing in flight, report "no ready items" and stop.

This command implements **merge policy A**: reviewer-gated auto-merge, with a money-path carve-out enforced by `.github/CODEOWNERS`. See `docs/contributing/autonomous-pr-loop.md`.

## Phase 0 — Serialize (never run two open PRs from one queue)

1. Before picking new work, check whether any issue in the selected queue already has an **open Haven PR** (a PR that `Closes #<issue>`). If so, act on that PR:
   - **Merged** (issue now closed) → continue to Phase 1.
   - **Open, awaiting the user** (a money-path PR needing CODEOWNERS approval, or an escalation) → **stop** and report: this item is blocked on the user; do not start the next item (later items branch off `dev` and must build on the merged one).
   - **Open, CI still running / fixable failure** → handle it (re-run, fix, push) but do not start a new item.
2. Only when there is no open in-flight PR from the queue do you pick the next ready issue.

## Phase 1 — Pick the next issue

3. Label mode: the lowest-numbered **open** issue carrying the loop label that has no linked open/merged Haven PR. Epic mode: the lowest-numbered **open** sub-issue not yet covered by an open/merged Haven PR.
4. If the issue's scope/acceptance is too vague to implement safely (no acceptance criteria, ambiguous surface), **stop and ask the user** to sharpen the issue body. A vague money-path issue is never guessed at.
5. Sync and branch off fresh `dev` (the integration branch — **not** `main`):
   - `git fetch origin dev && git checkout -B claude/issue-<n>-<slug> origin/dev` (use the issue number so the branch traces back to its issue).
   - The loop targets `dev` because the `dev-gate` workflow (`.github/workflows/dev-gate.yml`) only allows `dev` or `hotfix/*` into `main`; a `claude/*` branch can never merge straight to `main`. Feature work flows `claude/* → dev`, and `dev → main` is promoted separately.

## Phase 1.5 — Classify & load the playbook

The skill **routes, it does not contain.** Before implementing, classify the issue's surface(s) and load the matching playbook(s) — small files that link the standards, checks, and agents for that surface. Never restate guideline content; load and apply it. See `docs/contributing/ship-playbooks/README.md`. (Steps here are unnumbered — this phase is inserted between steps 5 and 6 without renumbering the rest.)

- **Classify.** Determine the surface(s):
  - **Primary:** the issue's labels — `area:frontend`, `area:backend`, `area:sdk`, `area:mcp`, `area:docs`, `money-path`.
  - **Fallback / confirmation:** the files the change will touch — `packages/frontend/**` → frontend; `packages/backend/**` → backend; `packages/{sdk,connect}/**` → sdk; `packages/{mcp,mcp-server,signer}/**` → mcp; `*.md`/`docs/**` → docs; the Phase 6 money-path file list → money-path. Use this when labels are missing, and to catch a surface the labels missed.
  - An issue can span several surfaces — load every matching playbook.
- **Load** the matching playbook(s) from `docs/contributing/ship-playbooks/` and apply them through Phases 2–6:

  | Surface | Playbook | Loads / enforces |
  |---|---|---|
  | `area:frontend` | `frontend.md` | UX + design-system required reading, reuse-first, Captain Self-Check Preflight, browser/headless verification, advisory design-review, UI merge policy |
  | `area:backend` | `backend.md` | OpenAPI drift + package gate |
  | `area:sdk` / `area:mcp` | `sdk.md` | generated-artifact regen/verify, OpenAPI drift, runtime-compatibility |
  | `money-path` | `money.md` | CASP required reading, characterization-tests-first, human merge gate (Phase 6) |
  | `area:docs` | `docs.md` → `docs-quality-system.md` | `docs:check` + coupling gate + haven-doc-reviewer |

- **Discovery.** For a non-trivial issue, run `haven-explorer` (and `haven-workflow-coordinator` for multi-surface work) to map terrain before implementing — scale this to the issue's complexity; skip it for a one-file change.

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

## Phase 4.5 — Doc accuracy (advisory)

- If the diff touches code that a doc's `covers:` front-matter maps to (the **docs coupling gate** flags these on the PR; you can also run `node scripts/docs/coupling-gate.mjs` locally), launch the **haven-doc-reviewer** subagent on the diff. Update any docs it finds stale/missing/broken, then re-run the acceptance gate. This is **advisory** — it never blocks the merge — but updating implicated docs is part of definition-of-done. See `docs/contributing/docs-quality-system.md`.

## Phase 5 — Open the PR

13. Commit with a conventional message (end with the Co-Authored-By / Claude-Session trailers per the repo convention). Push `-u origin <branch>`.
14. Open the PR via `mcp__github__create_pull_request` with **base `dev`** (never `main`). Body: scope, the behavior-preservation argument, verification output (test counts, tsc), and reviewer outcome. **Always include `Closes #<n>`** for the issue being shipped (standalone or epic sub-issue) so merging closes it and an epic burns down automatically.
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
      - **`area:frontend` (UI) — one addition** from [`ship-playbooks/frontend.md`](../../docs/contributing/ship-playbooks/frontend.md):
        if the design-review / haven-reviewer UI pass flagged a **UX, copy, or
        design-system** issue (even non-blocking), do **not** auto-merge —
        **ask the user** with `AskUserQuestion` (UX is a human call). With no
        such finding, auto-merge as normal.
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

## Phase 7 — Stop

18. State lives in GitHub, so there is nothing to edit in the repo: the open PR (with `Closes #<n>`) is the in-flight marker, and the issue closing on merge is the done marker. Leave the issue open until the PR merges.
19. Report a one-line status (issue #, PR link, gate result, merge mode) and **stop**. Do not begin the next item in the same run.

## When to involve the user (the only times)

- A blocking/ambiguous reviewer finding, or any real product/architecture/security decision.
- A money-path PR (it waits for the user's CODEOWNERS approval by design).
- CI failing in a way you can't resolve after a couple of focused attempts.
- An issue too underspecified to implement safely.
Everything else — implement, test, review nits, open PR, auto-merge clean PRs, chain to the next — runs without the user.
