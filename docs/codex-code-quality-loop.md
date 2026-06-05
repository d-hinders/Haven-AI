# Haven Code Quality Loop

Last updated: 2026-06-05

## Current Run

- Branch: `codex/quality-x402-history-chain-identity`
- PR target: x402/payment-history chain identity for backend transaction enrichment and x402 merge suppression.
- Why this target: it closes the next narrow read/display risk after PR #267. Raw explorer transfers can share a transaction hash across chains; agent/payment metadata now applies only when `tx_hash`, `safe_id`, and `chain_id` match. Normalized x402 history also resolves rows through the payment or approval record's stored `safe_address + chain_id`, not through an agent's current Safe alone. x402 replacement suppression now keys by `tx_hash + safe_id + chain_id`. It does not change custody, Safe ownership, signer authority, payment execution, production chain/token config, payment protocol behavior, public SDK/API shape, or frontend UX.
- Files touched: `packages/backend/src/routes/transactions.ts`, `packages/backend/src/routes/__tests__/transactions.test.ts`, and this loop file.

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
- Planned current PR: x402/payment-history enrichment resolves and applies agent/payment labels by Safe and chain identity instead of transaction hash alone.
- Prior roadmap exists at `docs/plans/code-quality-roadmap.md`; use this file as the running handoff for the small-PR quality loop going forward.

## Deferred Items

- x402/generic machine-payment consolidation: defer because it crosses idempotency, approval-state, expected-context binding, and multi-entrypoint behavior.
- Broader payment state rewrite, DB migrations, custody/signing semantics, Safe ownership assumptions, production chain/token config, and protocol compatibility changes need separate review.
- Broader x402/payment-history consolidation remains deferred; this PR only tightens backend history identity, stored Safe/chain joins, and x402 replacement suppression.
- Temporary frontend x402 activity bridge and `/agent-activity/feed` identity cleanup remain deferred to keep this PR backend read/display-only.

## Known Baseline Notes

- Baseline checks from this run before implementation:
  - `npm run test -w packages/backend -- transactions.test.ts dashboard.test.ts` passed.
- Focused checks after implementation:
  - `npm run test -w packages/backend -- transactions.test.ts dashboard.test.ts` passed.
- Full local gates after implementation:
  - `npm run test -w packages/backend` passed.
  - `npm run typecheck -w packages/backend` passed.
  - `npm run build -w packages/backend` passed.
- Explorer agent pass found backend tx-hash-only enrichment, unqualified agent Safe joins in normalized x402 history, and remaining frontend bridge/feed identity cleanup. Backend findings are fixed and covered in this PR; frontend bridge/feed cleanup is deferred.
- Captain self-review covered payment state identity, CASP guardrails, dashboard/transactions parity, secret leakage, and test sufficiency; no additional code issues found.
- Extra reviewer agent stalled and was closed before returning findings.
- Do not run package tests/typecheck/build in parallel when they trigger `npm --prefix ../sdk run build`; the SDK clean build can race on `packages/sdk/dist`.
- Existing untracked directory `docs/plans/haven-landing-audit-2026-06-04/` was present before this run and is unrelated.

## Recommended Next Target

After this PR merges, choose a narrow P0 x402 activity bridge target: either retire the temporary frontend x402 activity bridge now that backend `/transactions` and dashboard overview return normalized x402 rows, or harden `/agent-activity/feed` plus `mergeTransactionsWithX402Activity` to publish and dedupe by stored payment Safe address, `chainId`, `safeId`, and transaction hash. Keep it read/display-only and defer broader machine-payment consolidation.
