---
owner: "@d-hinders"
status: current
covers:
  - .github/ISSUE_TEMPLATE/loop-task.md
  - .github/ISSUE_TEMPLATE/loop-epic.md
  - .agents/skills/ship-next/SKILL.md
  - .github/CODEOWNERS
last-verified: "2026-10-25"
---

# Backlogs moved to GitHub Issues

The autonomous PR loop (`ship-next`, repeated by a client loop when available) used to read its queue from
`docs/backlogs/*.yml` tracks in this folder. **That mechanism is retired.** One
retired track, `route-coverage-dedup.yml`, is still in this folder as a record.
Nothing reads it, and its two `in-pr` items are stale: they shipped as PRs #563 and #564, both merged.

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
| **Epic + sub-issues** | a multi-PR plan that burns down together | open a parent issue with sub-issues → run `ship-next epic=#<n>`; its **Promotion checklist** (operator steps + product verification on `dev`, each an unticked box) keeps the epic open until a human ticks the last one — `ship-next` reports it ready to close only then ([#2767](https://github.com/d-hinders/Haven-AI/issues/2767)) |

Issue state *is* the backlog state: an open issue with no PR, no live claim or
work overlap, no open `Depends on` target, no **`pending-review`** label, and not from outside the
maintainers is **ready** (the full list of blockers is `ship-next` §
*Select The Work*; `pending-review` means its spec review or an owner
decision is still outstanding — `new-task` § *Hold until ready*; an
**external** issue — author neither a maintainer nor a Bot, not yet accepted by
a maintainer removing its `external` label — is never ready, whatever its labels
say: AGENTS.md § *Cross-session agent coordination*, rule 0b, #4200), an open issue with an open Haven PR is **in
flight**, and a **closed** issue is **done** (its PR closed it via
`Closes #`). Exception: an open issue labelled **`operator-verify`** is already
implemented and on `dev` — its PR wrote `Refs #<n>` so the merge would leave a
human's outstanding step a home (#2276). It is not ready work; don't queue it.
An open issue labelled **`landed-partial`** has a merged PR that references it
with `Refs #<n>`. The merge-time release workflow adds the label (#4235) to an
open, non-epic issue written by a maintainer. Part or all of it may have
landed, or the PR may only cite it: read that PR before building any of it.
The queue skips such an issue.

## Writing a loop-ready issue

The loop refuses to guess at vague work, so an issue needs the same rigor the
old YAML `scope:` field demanded. The **🔁 Loop task** issue template
(`.github/ISSUE_TEMPLATE/loop-task.md`) prompts for:

- **Scope** — one paragraph the implementer can act on without guessing: the
  change *and* its acceptance criteria.
- **Acceptance criteria** — the observable bar for "done", in a section of its
  own.
- **Files** — the file(s) the change should own (best-effort).
- **Design system** — for `area:frontend`, the existing `/design-system`
  Patterns it uses, every changed component and its other usages, and any
  proposed **new pattern**'s separate, earlier design-system slice for owner
  approval.
- **Surface** — which `area:*` / `money-path` label(s) apply, so `ship-next`
  loads the right playbook (see `docs/contributing/ship-playbooks/README.md`).
- **Money-path?** — whether it touches money-moving code or a migration. The
  list is [`.github/money-path-globs.json`](../../.github/money-path-globs.json)
  and nowhere else: `labeler.yml` applies it automatically and a CI test keeps
  the two in sync
  ([#1030](https://github.com/d-hinders/Haven-AI/issues/1030)). A prose copy is
  how the delegation rail went unlabelled for months, so this page does not
  keep one. The label selects the
  `money.md` playbook and the characterization-test bar; it does not pause the
  merge (#1024). Direct migration implementation `.ts` files require independent
  code-owner review and merge through `.github/CODEOWNERS`; migration tests do
  not.
- **Characterization-first** — the Money-path section's guidance, not a field
  of its own: for a change to existing money-path behavior, pin the current
  behavior with a test before changing it.

## History

The retired tracks all completed (or moved to issues):

- `code-quality-hardening` — done, PRs #539–#543.
- `route-coverage-dedup` — done, PRs #563–#565.
- `address-validation-dedup` — PR1 (#529) merged; the money-path PR2, PR #530,
  merged 2026-06-26; remaining money-path follow-ups were moved to GitHub Issues.

The [code-quality discovery method](../../.agents/skills/quality-scan/references/discovery-method.md)
describes how to inspect the repo. The [scan ledger](../quality/scan-ledger.md)
records historical findings, candidates, and decisions; GitHub holds the
implementation queue.
