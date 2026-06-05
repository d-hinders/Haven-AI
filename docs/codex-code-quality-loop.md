# Haven Code Quality Loop

Last updated: 2026-06-05

## Current Run

- Branch: `codex/quality-activity-readiness-chain-scope`
- PR target: chain-scope transaction/activity reads and dashboard activity previews.
- Why this target: it completes the read/display side of the same-address multi-chain hardening started in PR #265 and PR #266. Legacy transaction reads now accept explicit `chain_id`, refuse ambiguous address-only lookups, and avoid chain-blind activity dedupe. x402 history address fallback requires chain context instead of duplicating null-chain legacy rows across same-address Safes. Frontend activity hooks pass known chain context, prove bridge rows against current-user Safes, and ignore stale responses. It does not change custody, Safe ownership, signer authority, payment execution, production chain/token config, payment protocol behavior, or public SDK/API shape.
- Files touched: `packages/backend/src/routes/transactions.ts`, `packages/backend/src/routes/dashboard.ts`, `packages/backend/src/routes/__tests__/transactions.test.ts`, `packages/backend/src/routes/__tests__/dashboard.test.ts`, `packages/frontend/src/hooks/useTransactions.ts`, `packages/frontend/src/hooks/useAggregatedPortfolio.ts`, `packages/frontend/src/hooks/useTransactionsFeed.ts`, `packages/frontend/src/hooks/useDashboardOverview.ts`, `packages/frontend/src/lib/x402-activity-transactions.ts`, `packages/frontend/src/components/transactions/TransactionsTable.tsx`, `packages/frontend/src/app/(authenticated)/transactions/TransactionsClient.tsx`, `packages/frontend/src/app/(authenticated)/accounts/[safeId]/AccountDetailClient.tsx`, focused hook/bridge tests, and this loop file.

## Priority Backlog

- P0: Agent payment flow state hardening, especially x402/MPP idempotency, retry, approval-resume, and terminal-state behavior.
- P0: Agent credential handoff safety, including local credential file validation and secret redaction in generated artifacts, logs, errors, and tests.
- P0: Wallet/account setup readiness checks, including network, Safe deployment, funding, and chain/token mismatch handling.
- P0: Agent budget and policy flow consistency across allowance creation, remaining budget display, pause/revoke, and on-chain/account state.
- P1: Backend/API validation, error responses, logging safety, and shared response type coverage.
- P1: Test infrastructure reliability, especially avoiding hidden clean-build races and making local gates match CI.

## Completed Areas

- PR #258: machine-payment one-shot signature recording no longer sets `submitted` before RPC execution; regression coverage asserts pre-RPC SQL/call order and records `submitted_at` only when a tx hash exists.
- PR #259: x402 amount validation rejects hex, scientific notation, signed, negative, zero, blank, and whitespace-wrapped atomic values before payment work begins.
- PR #260: MPP demo challenge validation rejects invalid `expiresAt` timestamps before authorization, allowance, hash, or execution helpers run.
- PR #261: MCP split credential loading rejects mismatched `agent_id`, `safe_address`, `delegate_address`, `chain_id`, and `network` metadata before returning a merged credential.
- PR #262: signer credential loading accepts only positive integer `chain_id` / `HAVEN_CHAIN_ID` values and rejects malformed present values without leaking delegate key material.
- PR #263: env-based SDK/Python runtime examples reference `HAVEN_API_KEY` / `HAVEN_DELEGATE_KEY` but no longer echo raw credential values in comments.
- PR #264: generated handoff and skill-bundle tests assert reusable examples, skill descriptors, package metadata, and zip paths remain free of raw credential values.
- PR #265: chain-scoped Safe details and connected setup approval readiness prevent stale selected-wallet state or late Safe-detail responses from driving wallet approval and other money/authority readiness paths.
- PR #266: chain-scoped balance and portfolio reads prevent duplicate-address Safes and overlapping token symbols from driving wrong funding readiness or account totals.
- Planned current PR: chain-scoped transaction/activity reads prevent duplicate-address Safes from fetching, deduping, previewing, or labeling activity against the wrong chain.
- Prior roadmap exists at `docs/plans/code-quality-roadmap.md`; use this file as the running handoff for the small-PR quality loop going forward.

## Deferred Items

- x402/generic machine-payment consolidation: defer because it crosses idempotency, approval-state, expected-context binding, and multi-entrypoint behavior.
- Broader payment state rewrite, DB migrations, custody/signing semantics, Safe ownership assumptions, production chain/token config, and protocol compatibility changes need separate review.
- Broader x402/payment-history consolidation remains deferred; this PR only tightens the dangerous null-chain address fallback and frontend bridge identity proof.

## Known Baseline Notes

- Baseline checks from this run before implementation:
  - `npm run test -w packages/backend -- transactions.test.ts` passed.
  - `npm run test -w packages/frontend -- useAggregatedPortfolio.test.ts DashboardClient.test.tsx AccountDetailClient.test.tsx` passed.
- Focused checks after implementation:
  - `npm run test -w packages/backend -- transactions.test.ts dashboard.test.ts` passed.
  - `npm run test -w packages/frontend -- useTransactions.test.ts useAggregatedPortfolio.test.ts useTransactionsFeed.test.ts useDashboardOverview.test.ts x402-activity-transactions.test.ts` passed.
- Full local gates after implementation:
  - `npm run test -w packages/frontend` passed with the known `useAgentLastSeen.test.ts` React `act(...)` warning.
  - `npm run test -w packages/backend` passed.
  - `npm run typecheck -w packages/frontend` passed.
  - `npm run typecheck -w packages/backend` passed.
  - `npm run build -w packages/frontend` passed with existing optional wallet dependency warnings from MetaMask/WalletConnect packages.
  - `npm run build -w packages/backend` passed.
- Reviewer agent pass found two chain-identity issues in x402 history/bridge fallback; both were fixed and covered before final gates.
- Do not run package tests/typecheck/build in parallel when they trigger `npm --prefix ../sdk run build`; the SDK clean build can race on `packages/sdk/dist`.
- Existing untracked directory `docs/plans/haven-landing-audit-2026-06-04/` was present before this run and is unrelated.

## Recommended Next Target

After this PR merges, choose a narrow P0 payment-history identity target: tighten remaining x402/payment-history enrichment and merge suppression that still key primarily by tx hash, especially cross-chain same-hash edge cases. Keep it read/display-only and defer broader machine-payment consolidation.
