# Haven Code Quality Loop

Last updated: 2026-06-05

## Current Run

- Branch: `codex/quality-x402-activity-bridge-identity`
- PR target: retire the temporary frontend x402 activity bridge and harden `/agent-activity` Safe/chain identity.
- Why this target: it completes the read/display identity cleanup deferred from PR #268. The transactions feed and dashboard overview now trust the canonical backend x402 rows instead of faning out to `/agent-activity/feed`, `/agents`, and `/auth/me` to synthesize duplicate rows. Remaining agent activity endpoints resolve payment and approval rows through the payment record's stored `safe_address + chain_id`, and agent detail rows use the row's wallet name when rendering historical movement. It does not change custody, Safe ownership, signer authority, payment execution, production chain/token config, payment protocol behavior, SDK shape, or payment API authority.
- Files touched: `packages/backend/src/routes/agent-activity.ts`, `packages/backend/src/routes/__tests__/agent-activity.test.ts`, `packages/frontend/src/hooks/useTransactionsFeed.ts`, `packages/frontend/src/hooks/useDashboardOverview.ts`, related hook tests, agent detail activity mapping/tests, retired x402 bridge files, and this loop file.

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
- PR #267: chain-scoped transaction/activity reads prevent duplicate-address Safes from fetching, deduping, previewing, or labeling activity against the wrong chain.
- PR #268: x402/payment-history enrichment resolves and applies agent/payment labels by Safe and chain identity instead of transaction hash alone.
- Planned current PR: temporary frontend x402 bridge is retired, and agent activity feeds publish stored payment/approval Safe identity instead of an agent's current Safe.
- Prior roadmap exists at `docs/plans/code-quality-roadmap.md`; use this file as the running handoff for the small-PR quality loop going forward.

## Deferred Items

- x402/generic machine-payment consolidation: defer because it crosses idempotency, approval-state, expected-context binding, and multi-entrypoint behavior.
- Broader payment state rewrite, DB migrations, custody/signing semantics, Safe ownership assumptions, production chain/token config, and protocol compatibility changes need separate review.
- Broader x402/payment-history consolidation remains deferred; this PR only removes the temporary bridge and tightens remaining agent activity read identity.

## Known Baseline Notes

- Baseline checks from this run before implementation:
  - `npm run test -w packages/backend -- transactions.test.ts dashboard.test.ts` passed.
  - `npm run test -w packages/frontend -- useTransactionsFeed.test.ts useDashboardOverview.test.ts x402-activity-transactions.test.ts` passed.
- Focused checks after implementation:
  - `npm run test -w packages/backend -- agent-activity.test.ts` passed.
  - `npm run test -w packages/frontend -- useTransactionsFeed.test.ts useDashboardOverview.test.ts AgentDetailClient.test.tsx` passed.
- Full local gates after implementation:
  - `npm run test -w packages/backend` passed.
  - `npm run test -w packages/frontend` passed with the known `useAgentLastSeen.test.ts` React `act(...)` warning.
  - `npm run typecheck -w packages/backend` passed.
  - `npm run typecheck -w packages/frontend` passed.
  - `npm run build -w packages/backend` passed.
  - `npm run build -w packages/frontend` passed with existing optional wallet dependency warnings from MetaMask/WalletConnect packages.
- Explorer agent pass recommended the same smallest PR: retire the frontend bridge, resolve `/agent-activity` through stored Safe address and chain, and cover the endpoint/hooks.
- Captain self-review covered payment state identity, CASP guardrails, frontend/backend parity, secret leakage, UI data mapping, and test sufficiency; no additional code issues found so far.
- Reviewer agent found one historical activity wallet-label fallback that could still use the current agent wallet when `safe_name` was missing; it was fixed with a row-address fallback and regression coverage.
- Do not run package tests/typecheck/build in parallel when they trigger `npm --prefix ../sdk run build`; the SDK clean build can race on `packages/sdk/dist`.
- Existing untracked directory `docs/plans/haven-landing-audit-2026-06-04/` was present before this run and is unrelated.

## Recommended Next Target

After this PR merges, choose a narrow P0 agent budget and policy consistency target: audit allowance creation, remaining budget display, pause/revoke state, and on-chain/account state for stale Safe or chain assumptions. Keep the first PR read/display or validation-only where possible, and defer broader payment-state rewrites.
