# Haven Code Quality Loop

Last updated: 2026-06-05

## Current Run

- Branch: `codex/quality-balance-readiness-chain-scope`
- PR target: chain-scope balance and portfolio reads that drive funding readiness and account totals.
- Why this target: it is a narrow read/display hardening item that uses known Haven wallet chain IDs for `/balances` and `/portfolio` reads, prevents same-address multi-chain wallets from falling back to an arbitrary owned row, and prevents same-symbol balances on different chains from being collapsed into one funding signal. It does not change custody, Safe ownership, signer authority, payment execution, production chain/token config, or public SDK/API shape.
- Files touched: `packages/backend/src/routes/balances.ts`, `packages/backend/src/routes/portfolio.ts`, `packages/backend/src/routes/__tests__/balances.test.ts`, `packages/backend/src/routes/__tests__/portfolio.test.ts`, `packages/frontend/src/hooks/useBalances.ts`, `packages/frontend/src/hooks/usePortfolio.ts`, `packages/frontend/src/hooks/useAggregatedPortfolio.ts`, `packages/frontend/src/hooks/__tests__/useBalances.test.ts`, `packages/frontend/src/hooks/__tests__/usePortfolio.test.ts`, `packages/frontend/src/hooks/__tests__/useAggregatedPortfolio.test.ts`, `packages/frontend/src/types/transactions.ts`, `packages/frontend/src/components/DashboardSendModal.tsx`, `packages/frontend/src/app/(authenticated)/dashboard/DashboardClient.tsx`, `packages/frontend/src/app/(authenticated)/dashboard/__tests__/DashboardClient.test.tsx`, `packages/frontend/src/app/(authenticated)/accounts/[safeId]/AccountDetailClient.tsx`, `packages/frontend/src/app/(authenticated)/accounts/AccountsOverviewClient.tsx`, and this loop file.

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
- Planned current PR: chain-scoped balance and portfolio reads prevent duplicate-address Safes and overlapping token symbols from driving wrong funding readiness or account totals.
- Prior roadmap exists at `docs/plans/code-quality-roadmap.md`; use this file as the running handoff for the small-PR quality loop going forward.

## Deferred Items

- x402/generic machine-payment consolidation: defer because it crosses idempotency, approval-state, expected-context binding, and multi-entrypoint behavior.
- Broader payment state rewrite, DB migrations, custody/signing semantics, Safe ownership assumptions, production chain/token config, and protocol compatibility changes need separate review.

## Known Baseline Notes

- Baseline checks from this run before implementation:
  - `npm run test -w packages/frontend -- DashboardClient.test.tsx` passed.
  - `npm run test -w packages/backend -- dashboard.test.ts user.test.ts` passed.
- Focused checks after implementation:
  - `npm run test -w packages/backend -- balances.test.ts portfolio.test.ts` passed.
  - `npm run test -w packages/frontend -- useBalances.test.ts usePortfolio.test.ts useAggregatedPortfolio.test.ts DashboardClient.test.tsx` passed.
- Full local gates after implementation:
  - `npm run test -w packages/frontend` passed with the known `useAgentLastSeen.test.ts` React `act(...)` warning.
  - `npm run test -w packages/backend` passed.
  - `npm run typecheck -w packages/frontend` passed.
  - `npm run typecheck -w packages/backend` passed.
  - `npm run build -w packages/frontend` passed with existing optional wallet dependency warnings from MetaMask/WalletConnect packages.
  - `npm run build -w packages/backend` passed.
- Do not run package tests/typecheck/build in parallel when they trigger `npm --prefix ../sdk run build`; the SDK clean build can race on `packages/sdk/dist`.
- Existing untracked directory `docs/plans/haven-landing-audit-2026-06-04/` was present before this run and is unrelated.

## Recommended Next Target

After this PR merges, choose a narrow P0 chain-scoped activity/readiness target: backend `/transactions/:safeAddress` and frontend aggregated activity still key primarily by address, so same-address multi-chain wallets can fetch or dedupe activity against the wrong chain. Keep it read/display-only with optional `chain_id`, stale-response coverage, and chain-aware de-dupe; defer broader account detail consolidation.
