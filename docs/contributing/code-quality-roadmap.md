# Haven Code Quality Roadmap

Last updated: 2026-05-13

> **Point-in-time plan.** This is the strategic roadmap as of the date above;
> some named surfaces have since changed (e.g. the old `CreateAgentModal` was
> split out and replaced by `ConnectAgent2Modal` in #345). File paths below have
> been refreshed to current locations, but treat the phase analysis as the
> snapshot it was. The live, tactical status is tracked in
> [code-quality-loop.md](code-quality-loop.md).

## Summary

This roadmap starts a risk-first, whole-repo quality program for Haven. Phase 0 is intentionally audit-only: no product behavior changes, no schema changes, and no cleanup hidden inside the planning PR.

The goal is faster iteration with higher confidence around money movement, agent authority, approval states, x402/machine-payment behavior, and the UI flows that explain those risks to users.

## Baseline Checks

Commands run locally from `codex/code-quality-roadmap`:

| Check | Result | Notes |
| --- | --- | --- |
| `npm run test` | Passed | Backend 71 tests, frontend 136 tests, SDK 10 tests. Frontend tests print repeated `useToast() was called outside of <ToastProvider>` warnings. |
| `npm run build` | Passed | Backend `tsc`, frontend `next build`, and SDK `tsup` completed. Frontend build warns about optional wallet dependency imports from MetaMask/WalletConnect packages. |
| `npm run typecheck -w packages/sdk` | Passed | SDK has a package-level typecheck script. |
| `npm run lint -w packages/frontend` | Failed | `next lint` is deprecated and prompts for ESLint setup; it is not a usable non-interactive gate today. |
| `npm run test:e2e:desktop -w packages/frontend` | Failed locally | First sandboxed run could not bind `127.0.0.1:3000` (`EPERM`). Elevated rerun started the server, then all 5 Chromium desktop tests timed out on initial `page.goto` with `net::ERR_ABORTED`. |

Baseline interpretation:

- Unit coverage is healthy enough to support incremental hardening.
- The local/CI quality gate story is inconsistent: CI typechecks directly, package scripts do not line up, and lint is named but not operational.
- Desktop Playwright needs a reliability pass before it can be trusted as a local smoke gate.

## Priority Risks

### P0: Payment And Approval State Correctness

- Payment signing paths can race because rows are loaded in one status and later updated without conditional status guards.
- A later execution failure can overwrite a row that may already have moved forward.
- Approval execution can mark requests as `executed` from a submitted transaction hash without verifying receipt success or matching safe/token/recipient/amount.
- `pending_signature` and approval expiry behavior is lazy and inconsistent across reads, signing, x402 replay, and machine-payment replay.

Primary surfaces:

- `packages/backend/src/routes/payments.ts`
- `packages/backend/src/routes/approvals.ts`
- `packages/backend/src/routes/x402.ts`
- `packages/backend/src/lib/machine-payments.ts`

### P0: x402 And Machine-Payment Idempotency

- x402 payment intents have idempotency metadata, but over-allowance approval creation can duplicate approval rows.
- Legacy x402 and newer machine-payment helpers appear to have diverged.
- Funded-but-not-settled delegate wallet scenarios are not tracked durably enough for reconciliation or sweep follow-up.

Primary surfaces:

- `packages/backend/src/routes/x402.ts`
- `packages/backend/src/lib/machine-payments.ts`
- `packages/backend/src/db/migrations/010_x402_standard_metadata.ts`
- `packages/backend/src/db/migrations/012_machine_payment_metadata.ts`
- `packages/sdk/src/client.ts`

### P1: API And Status Contracts

- Payment and approval statuses are stringly typed at the database/API boundary.
- Frontend approval status handling accepts `status: string`, so new backend states can silently become unclear or non-actionable.
- SDK types narrow some contracts, but backend response shapes are not enforced end to end.

Primary surfaces:

- `packages/backend/src/db/migrations/000_initial.ts`
- `packages/backend/src/routes/*`
- `packages/frontend/src/hooks/useApprovals.ts`
- `packages/frontend/src/components/ApprovalQueue.tsx`
- `packages/sdk/src/types.ts`

### P1: Agent Authority Setup Reliability

- `CreateAgentModal` owns too many responsibilities: token/budget form, on-chain setup, Safe proposal/execution, backend save, credential handoff, wallet selection, and multi-step UX state.
- A partial success can leave authority created or proposed on-chain before the backend agent save fails.
- Agent setup copy still exposes technical implementation detail in primary UX.

Primary surfaces:

- `packages/frontend/src/components/ConnectAgent2Modal.tsx`
- `packages/frontend/src/components/EditAgentModal.tsx`
- `packages/frontend/src/components/AgentPanel.tsx`
- `packages/frontend/src/hooks/useOnChainAllowances.ts`

### P1: Money Display And Transaction Semantics

- Send/budget flows rely on formatted strings and `parseFloat` in places where token decimals and precision matter.
- Transaction history temporarily merges x402 activity client-side while counts still come from backend totals, so “Showing X of Y” can drift.
- Shared presentation exists for transaction movement, but ownership between backend durable totals and frontend preview shims needs tightening.

Primary surfaces:

- `packages/frontend/src/components/SendModal.tsx`
- `packages/frontend/src/hooks/useTransactionsFeed.ts`
- `packages/frontend/src/lib/transaction-scope.ts`
- `packages/frontend/src/components/transactions/TransactionsTable.tsx`
- `packages/frontend/src/components/haven/TransactionMovement.tsx`

### P2: Modal Accessibility And Test Noise

- Some high-risk money/authority modals hand-roll overlays instead of reusing the shared modal primitive with dialog semantics and focus behavior.
- Unit tests pass but emit repeated missing `ToastProvider` warnings, which makes real warning regressions harder to see.
- Playwright desktop smoke is currently not reliable locally.

Primary surfaces:

- `packages/frontend/src/components/ui/Modal.tsx`
- `packages/frontend/src/components/SendModal.tsx`
- `packages/frontend/src/components/ConnectAgent2Modal.tsx`
- `packages/frontend/src/components/EditAgentModal.tsx`
- `packages/frontend/src/__tests__/setup.ts`
- `packages/frontend/e2e/*`

## Proposed PR Phases

### Phase 1: Quality Gates And Developer Workflow

Intent: make local and CI checks explicit, non-interactive, and consistent.

Note: the agentic workflow audit is a docs, prompt, and PR-template precursor to this phase. It should not change package scripts, lockfiles, or CI behavior. Keep package and workflow-enforcement changes in a separate Phase 1 PR.

Changes:

- Add package-level `typecheck` scripts for backend and frontend.
- Add root scripts for `typecheck`, `test:unit`, and a conservative `quality` command that mirrors current reliable gates.
- Do not add lint as a required gate until the ESLint migration is explicit and non-interactive.
- Update CI to call package/root scripts instead of ad hoc `npx tsc` commands.
- Update `docs/contributing/pr-workflow-checklist.md` with exact check commands by change type.
- Add a Playwright reliability note: local desktop smoke may need CI-like server mode or cache cleanup before it is a dependable local gate.

Ownership:

- Captain owns package files, lockfile if scripts cause metadata changes, `.github/workflows/ci.yml`, and workflow docs.
- No workers for package/workflow gravity files unless the captain explicitly scopes a read-only audit.

Acceptance checks:

- `npm run typecheck`
- `npm run test:unit`
- `npm run quality`
- `npm run build`
- `npm run lint -w packages/frontend` is either removed from required docs or replaced with a real non-interactive lint command.

### Phase 2: Backend Payment And Approval State Hardening

Intent: prevent duplicate execution, stale status reads, and invalid executed states.

Changes:

- Add conditional status transitions for signing/execution paths, using `WHERE status = ... RETURNING` or transaction/locking boundaries where appropriate.
- Prevent terminal-state overwrites such as confirmed/executed rows being marked failed by a later path.
- Normalize expiry handling on reads and replay paths for `pending_signature` and approval-like states.
- Verify approval execution transaction receipts and expected payment details before marking rows executed.
- Add focused backend regression tests for concurrent sign attempts, stale `pending_signature`, invalid tx hash approval completion, and terminal-state protection.

Ownership:

- Backend worker can own one route/test pair at a time.
- Captain owns cross-route state semantics and any shared status/type changes.

Acceptance checks:

- `npm run test -w packages/backend`
- `npm run build -w packages/backend`
- Relevant SDK type/tests if response contracts change.

### Phase 3: x402 And Machine-Payment Contract Consolidation

Intent: make x402/machine-payment idempotency, approval creation, and reconciliation semantics durable and testable.

Changes:

- Consolidate legacy `/x402` behavior with the newer machine-payment helper or backport the newer idempotency/metadata behavior.
- Ensure over-allowance x402 approvals are idempotent and carry enough merchant/protocol metadata.
- Add tests for duplicate x402 approval requests, expired replay, DB conflicts, and SDK handling of `pending_approval` and `expired`.
- Define a minimal durable record for funded-but-not-settled delegate-wallet cases, even if sweeping remains a later operational feature.
- Current target: record authenticated reconciliation events when a merchant/resource retry returns 402 after Haven has confirmed the payment; defer automated sweeping/retry jobs to a later operational phase.

Ownership:

- Backend worker owns isolated x402/machine-payment implementation tests.
- SDK worker, if used, owns SDK contract/error tests only.
- Captain owns shared wire-shape decisions.

Acceptance checks:

- `npm run test -w packages/backend`
- `npm run build -w packages/backend`
- `npm run typecheck -w packages/sdk`
- `npm run test -w packages/sdk`

### Phase 4: Frontend Money, Status, And Transaction Consistency

Intent: remove quiet UX correctness risks in money and authority surfaces.

Changes:

- Introduce or consolidate decimal-aware money parsing/validation utilities for send and budget flows.
- Type approval statuses end to end in frontend code and centralize user-facing labels/actions.
- Clarify transaction feed ownership: either move x402 merge/backfill server-side or make client-side preview rows explicit in counts/empty states.
- Add tests for selected wallet, chain, token, recipient, signer context, approval status transitions, and transaction-count semantics.

Ownership:

- UI workers can own one bounded surface at a time, such as send money validation or approval status presentation.
- Captain owns shared transaction/money utility decisions and cross-surface consistency.

Acceptance checks:

- `npm run test -w packages/frontend`
- `npm run build -w packages/frontend`
- Browser checks for `/dashboard`, `/approvals`, `/transactions`, and send/receive flows when UI changes are visible.

### Phase 5: Agent Setup UX And Recovery

Intent: make agent authority setup clearer, smaller, and safer to recover from.

Changes:

- Split `CreateAgentModal` into smaller domain pieces only where it reduces concrete complexity.
- Add explicit partial-success recovery UX for “on-chain/proposal succeeded, backend save failed.”
- Replace technical setup copy with Haven language that explains who can spend, from which wallet, how much, and when approval is required.
- Add focused tests for backend-save failure after on-chain/proposal success, credential handoff, and budget form validation.

Ownership:

- Captain owns decomposition boundaries.
- UI worker can own extracted leaf components or focused tests after ownership is explicit.

Acceptance checks:

- `npm run test -w packages/frontend`
- `npm run build -w packages/frontend`
- Desktop and mobile browser checks for `/agents` and agent setup.

### Phase 6: Modal Accessibility And Maintainability Cleanup

Intent: reduce UI friction and noisy tests after higher-risk correctness work lands.

Changes:

- Reuse or extend the shared modal primitive for high-risk money/authority modals where practical.
- Preserve signing/wallet behavior while improving dialog semantics, Escape/backdrop behavior, focus handling, and laptop-screen fit.
- Fix repeated test warning setup, especially missing `ToastProvider` wrappers.
- Address stale TODOs, dead code, naming drift, and low-risk duplication found during earlier phases.

Ownership:

- UI worker can own a single modal family per PR.
- Captain owns shared primitive changes and final browser verification.

Acceptance checks:

- `npm run test -w packages/frontend`
- `npm run build -w packages/frontend`
- Targeted Playwright/browser checks once the desktop smoke reliability issue is understood.

## Agent Workflow For Follow-Up PRs

- Main session stays captain.
- Use `haven-workflow-coordinator` at the start of each non-trivial phase.
- Use read-only explorers before implementation if a phase spans multiple surfaces.
- Use workers only after the captain defines explicit file ownership.
- Keep gravity files with the captain: package files, lockfiles, global styles, Tailwind config, shared UI primitives, route shells, generated files, central API clients, central shared types, and CI/workflow files.
- Use `haven-reviewer` before completing phases that touch money movement, agent authority, shared API contracts, status transitions, or primary UX.

## Phase Selection Guidance

Default next PR: Phase 1.

Rationale:

- The current checks already exist but are not packaged consistently for local work.
- Phase 1 gives every later risk fix a clear, repeatable validation baseline.
- Lint should not become a blocker until it is deliberately migrated away from interactive `next lint`.

After Phase 1, prioritize Phase 2 before frontend polish. Payment and approval state correctness has the highest blast radius because it affects money movement, audit truth, and user trust.
