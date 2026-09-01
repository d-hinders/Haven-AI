---
owner: "@d-hinders"
status: current
covers:
  - .github/ISSUE_TEMPLATE/loop-task.md
  - .github/ISSUE_TEMPLATE/loop-epic.md
  - .agents/skills/ship-next/SKILL.md
  - .github/CODEOWNERS
last-verified: "2026-08-31" # #2276: the queue-state table said a closed issue is done and implied every open issue is ready; an `operator-verify` issue is neither — merged code, open on purpose, not queueable. Added that one exception. Scope: the queue-state paragraph only; the issue-writing rigour section and the loop-template mapping were NOT re-verified. Prior: #1341: re-verified queue readiness after ship-next gained #1289 active-claim coordination
---

# Backlogs moved to GitHub Issues

The autonomous PR loop (`ship-next`, repeated by a client loop when available) used to read its queue from
`docs/backlogs/*.yml` tracks in this folder. **That mechanism is retired.**

With the `dev` → `main` branch split and the merge rulesets, an in-repo status
file drifts out of sync between branches (a status update lands on `dev` first
and `main` stays stale until the next promotion) and has to be hand-reconciled.
GitHub Issues live outside git, so they are a single source of truth for both
humans and the loop on every branch.

## Where the queue lives now

The loop reads **GitHub Issues**. Two sources (see
[`../contributing/autonomous-pr-loop.md`](../contributing/autonomous-pr-loop.md)):

| Source | When | How to run |
| --- | --- | --- |
| **Standalone labeled issue** | a small, self-contained task | open an issue + add the **`code-quality`** label → run `ship-next` |
| **Epic + sub-issues** | a multi-PR plan that burns down together | open a parent issue with sub-issues → run `ship-next epic=#<n>` |

Issue state *is* the backlog state: an open issue with no PR and no live claim
or work overlap is **ready**, an open issue with an open Haven PR is **in
flight**, and a **closed** issue is **done** (its PR closed it via
`Closes #`). Exception: an open issue labelled **`operator-verify`** is already
implemented and on `dev` — its PR wrote `Refs #<n>` so the merge would leave a
human's outstanding step a home (#2276). It is not ready work; don't queue it.

## Writing a loop-ready issue

The loop refuses to guess at vague work, so an issue needs the same rigor the
old YAML `scope:` field demanded. The **🔁 Loop task** issue template
(`.github/ISSUE_TEMPLATE/loop-task.md`) prompts for:

- **Scope** — one paragraph the implementer can act on without guessing: the
  change *and* its acceptance criteria.
- **Files** — the file(s) the change should own (best-effort).
- **Surface** — which `area:*` / `money-path` label(s) apply, so `ship-next`
  loads the right playbook (see `docs/contributing/ship-playbooks/README.md`).
- **Money-path?** — whether it touches x402, machine-payments, payment-coverage,
  allowances, the **delegation rail** or rail seam, the SDK signer, or
  migrations. Don't work from this summary: the authoritative list is
  [`.github/money-path-globs.json`](../../.github/money-path-globs.json), which
  `labeler.yml` applies automatically and a test keeps in sync
  ([#1030](https://github.com/d-hinders/Haven-AI/issues/1030)) — a prose copy is
  how the delegation rail went unlabelled for months. The label selects the
  `money.md` playbook and the characterization-test bar; it does not pause the
  merge (#1024). Migrations require independent code-owner review and merge
  through `.github/CODEOWNERS`.
- **Characterization-first** — for a change to existing money-path behavior, pin
  the current behavior with a test before changing it.

## History

The retired tracks all completed (or moved to issues):

- `code-quality-hardening` — done, PRs #539–#543.
- `route-coverage-dedup` — done, PRs #563–#565.
- `address-validation-dedup` — PR1 (#529) merged; the money-path PR2 is open as
  PR #530; remaining money-path follow-ups were moved to GitHub Issues.

The human-curated code-quality cadence ledger still lives at
[`../contributing/code-quality-loop.md`](../contributing/code-quality-loop.md) —
that is a discovery/priority record, separate from the loop's runtime queue.
