---
owner: "@d-hinders"
status: current
covers:
  - .github/ISSUE_TEMPLATE/loop-task.md
  - .github/ISSUE_TEMPLATE/loop-epic.md
  - .claude/commands/ship-next.md
  - .github/CODEOWNERS
last-verified: "2026-06-29"
---

# Backlogs moved to GitHub Issues

The autonomous PR loop (`/ship-next` + `/loop`) used to read its queue from
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
| **Standalone labeled issue** | a small, self-contained task | open an issue + add the **`code-quality`** label → `/loop /ship-next` |
| **Epic + sub-issues** | a multi-PR plan that burns down together | open a parent issue with sub-issues → `/loop /ship-next epic=#<n>` |

Issue state *is* the backlog state: an open issue with no PR is **ready**, an
open issue with an open Haven PR is **in flight**, and a **closed** issue is
**done** (its PR closed it via `Closes #`).

## Writing a loop-ready issue

The loop refuses to guess at vague work, so an issue needs the same rigor the
old YAML `scope:` field demanded. The **🔁 Loop task** issue template
(`.github/ISSUE_TEMPLATE/loop-task.md`) prompts for:

- **Scope** — one paragraph the implementer can act on without guessing: the
  change *and* its acceptance criteria.
- **Files** — the file(s) the change should own (best-effort).
- **Surface** — which `area:*` / `money-path` label(s) apply, so `/ship-next`
  loads the right playbook (see `docs/contributing/ship-playbooks/README.md`).
- **Money-path?** — whether it touches x402 / machine-payments / payment-coverage
  / allowance / migrations. Money-path issues are implemented by the loop but
  **never auto-merged** — `.github/CODEOWNERS` routes them to a human merge.
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
