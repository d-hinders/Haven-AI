---
owner: "@d-hinders"
status: current
covers:
  - .claude/commands/ship-next.md
  - .github/ISSUE_TEMPLATE/loop-task.md
  - .github/ISSUE_TEMPLATE/loop-epic.md
  - .claude/agents/haven-reviewer.md
  - .agents/skills/haven-agent-workflow/references/reviewer.md
  - docs/backlogs/README.md
  - docs/contributing/ai-agent-workflow.md
  - docs/contributing/autonomous-pr-loop.md
  - docs/contributing/loop-engineering.md
  - docs/contributing/loop-harness-index.md
last-verified: "2026-07-01"
---

# Haven Code Quality Loop

This is the stable discovery and prioritization method for small, guarded code
quality PRs. It is not the runtime queue: actionable work lives in standalone
GitHub Issues labeled `code-quality`, or in open sub-issues of a selected epic.
The old `docs/backlogs/*.yml` tracks are retired.

It is distinct from the issue-driven autonomous PR loop (`/loop /ship-next`)
in [`autonomous-pr-loop.md`](autonomous-pr-loop.md), and from oracle-grounded
differential campaigns in [`loop-engineering.md`](loop-engineering.md).

## Run a quality pass

1. Discover against current code and recent commits, not a dated backlog.
2. Prefer money movement, agent authority, external financial writes, state
   transitions, and credential boundaries.
3. Keep one PR narrow, guarded, reversible, and free of unrelated behavior.
4. Add a machine-checkable invariant where practical.
5. Run focused and package checks, typecheck/build where relevant, and
   `git diff --check`.
6. Use `haven-reviewer` for money, authority, shared contracts, and primary UX.
7. Record actionable follow-up as a GitHub Issue, not an in-document queue.

Promote findings that need migrations, custody/signing changes, or coordinated
multi-entrypoint work to an epic with bounded sub-issues.

## Discovery prompts

- Which live route or library lacks an invariant-level test?
- Can invalid input reach a financial or external side effect?
- Can retry duplicate a write, settlement, or state transition?
- Can secrets appear in responses, logs, errors, or generated artifacts?
- Does an off-chain mirror disagree with its contract or other oracle?
- Did an API, OpenAPI, UI, or documentation contract drift?

OpenAPI scope is intentional: `packages/backend/src/openapi/spec.ts` publishes
the agent-payment surface, not every dashboard/accounting route. Expanding it
is a product/API scope decision, not an automatic quality fix.

## Coverage summary

Hardened areas include allowance routing, payment terminal states, x402/MPP
validation, delegate credential redaction, chain-scoped reads, owner-side
allowance writes, reconciliation status, receipt contracts, reporting-feed
deduplication, Fortnox token hygiene, and Fortnox/contact/reporting route
invariants.

PT-1 x402/machine-payment consolidation is complete; see
[`x402-mpp-consolidation.md`](x402-mpp-consolidation.md). User-triggered
gasless delegate sweep is shipped. Automated merchant retry and broader
operational reconciliation jobs remain separate future work.

Select the next target from open GitHub Issues after re-validating it against
current code. This document intentionally has no “current run” or
recommended-next snapshot.

## Verification baseline

For backend work, run focused tests, the full backend suite, typecheck, build,
and `git diff --check`. Avoid concurrent commands that clean/build shared SDK
output. Apply the Captain Self-Check Preflight in
[`ai-agent-workflow.md`](ai-agent-workflow.md).
