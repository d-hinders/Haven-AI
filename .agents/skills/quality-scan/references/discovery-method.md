# Code-quality discovery method

Folded here from `docs/contributing/code-quality-loop.md` by #2640, which
required one canonical statement per fact. This is the stable discovery and
prioritisation method for small, guarded code-quality PRs — the input to
`quality-scan`, not a runtime queue. Actionable work lives in standalone GitHub
Issues labelled `code-quality`, or in open sub-issues of a selected epic.

It is distinct from the issue-driven autonomous PR loop
(`docs/contributing/autonomous-pr-loop.md`) and from oracle-grounded
differential campaigns (`docs/contributing/loop-engineering.md`), which are a
different concept and stay where they are.

## Scan output and coverage

Apply the [canonical skill's output levels](../SKILL.md): strict structural
findings and bounded improvement candidates. One-PR opportunities can be
candidates when evidence shows a failure mechanism or contributor burden.
The implementation steps below describe verification expectations for approved
work; they do not authorize a scan to edit code, file issues, or ship.

Record each dimension as examined, partial, or not examined with the revision,
commands, results, sample boundaries and missing verification/reason. An
unexecuted check contributes no clean result. Use the canonical skill's ledger
exclusions and approval handoff rather than keeping a second candidate queue.

## Run a quality pass

1. Discover against current code and recent commits, not a dated backlog.
2. Prefer money movement, agent authority, external financial writes, state
   transitions, and credential boundaries.
3. Keep one PR narrow, guarded, reversible, and free of unrelated behavior.
4. Add a machine-checkable invariant where practical.
5. Run focused and package checks, typecheck/build where relevant, and
   `git diff --check`.
6. Run `haven-reviewer` — on every pull request, not only for money, authority,
   shared contracts, or primary UX. Unconditional since the 2026-08-21 owner
   decision; `CLAUDE.md` § *How shipping is governed* is canonical since #2639.
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

Live hardened areas include payment terminal states, x402/MPP validation,
delegation-budget enforcement, delegate credential redaction, chain-scoped
reads, reconciliation status, receipt contracts, reporting-feed deduplication,
Fortnox token hygiene, and Fortnox/contact/reporting route invariants.

Historical coverage includes AllowanceModule routing and owner-side allowance
writes. That rail is retired and fail-closed for agent payments; remaining
allowance math is historical display/test coverage, not live agent authority.

PT-1 x402/machine-payment consolidation is complete; see
[`x402-mpp-consolidation.md`](../../../../docs/contributing/x402-mpp-consolidation.md). User-triggered
gasless delegate sweep is shipped. Automated merchant retry and broader
operational reconciliation jobs remain separate future work.

Select the next target from open GitHub Issues after re-validating it against
current code. This document intentionally has no “current run” or
recommended-next snapshot.

## Verification baseline

For backend work, run focused tests, the full backend suite, typecheck, build,
and `git diff --check`. Avoid concurrent commands that clean/build shared SDK
output. Apply the Captain Self-Check Preflight in
[`ai-agent-workflow.md`](../../../../docs/contributing/ai-agent-workflow.md).
