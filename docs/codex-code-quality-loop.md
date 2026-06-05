# Haven Code Quality Loop

Last updated: 2026-06-05

## Current Run

- Branch: `codex/quality-payment-terminal-state-guards`
- PR target: guard one-shot machine-payment and x402 payment-intent mutations so retry, signature, confirmation, failure, and stale sign-data refresh writes only apply while the row is still the expected pending payment row.
- Why this target: it is the next narrow payment-state hardening after the pre-RPC `submitted` fix. The shared MPP/generic helper and legacy x402 route now use compare-and-set style predicates for signature recording, terminal success/failure writes, and stale nonce/hash refreshes. This protects confirmed/failed terminal rows from later retry or failure-path overwrites without changing custody, Safe ownership, signer authority, payment execution, database schema, protocol behavior, SDK shape, or product UX.
- Files touched: `packages/backend/src/lib/machine-payments.ts`, `packages/backend/src/routes/x402.ts`, related backend route tests, and this loop file.

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
- PR #269: temporary frontend x402 bridge was retired, and agent activity feeds publish stored payment/approval Safe identity instead of an agent's current Safe.
- PR #270: list-level agent budget edit/revoke actions are active-wallet scoped, and agent detail uses stored wallet chain identity when auth state is missing that wallet.
- PR #271: owner-side agent allowance mirror writes reject invalid token, amount, reset-period, duplicate-token, and revoked-agent mutation states before storing rows.
- Planned current PR: one-shot x402 and MPP/generic machine-payment writes are terminal-state guarded for signature recording, stale sign-data refresh, confirmed transition, and failed transition.
- Prior roadmap exists at `docs/plans/code-quality-roadmap.md`; use this file as the running handoff for the small-PR quality loop going forward.

## Deferred Items

- x402/generic machine-payment consolidation: defer because it crosses idempotency, approval-state, expected-context binding, and multi-entrypoint behavior.
- Broader payment state rewrite, DB migrations, custody/signing semantics, Safe ownership assumptions, production chain/token config, and protocol compatibility changes need separate review.
- Broader x402/payment-history consolidation remains deferred.
- Older `/self-sign-agents` allowance parity remains deferred because the current PR is scoped to payment-intent state guards.
- Reconciliation-event immutability is deferred: `machine_payment_reconciliation_events` can reopen a resolved event on conflict today, but this PR stays scoped to payment-intent state and signable metadata rows.

## Known Baseline Notes

- Focused checks after implementation:
  - `npm run test -w packages/backend -- machine-payments.test.ts x402.test.ts` passed.
- Full local gates after implementation:
  - `npm run test -w packages/backend` passed.
  - `npm run typecheck -w packages/backend` passed.
  - `npm run build -w packages/backend` passed.
  - `git diff --check` passed.
- Explorer agent pass recommended this smallest PR: guard x402 and generic one-shot payment-intent signature, terminal, and retry-refresh writes with `agent_id`, rail, expected `pending_signature` status, and empty `tx_hash`.
- Reviewer agent flagged cross-rail idempotency lookups and a missing x402 confirmation-race regression; both were fixed with rail-scoped selectors and x402 parity coverage.
- Residual follow-up: failed-execution paths now avoid overwriting terminal rows but still return `status: failed` when the guarded failed update loses a race, matching the existing `/payments/:id/sign` behavior.
- Captain self-check covered CASP guardrails, payment-authority boundaries, multi-entrypoint x402/MPP parity, terminal-state overwrite risk, secret leakage, and test sufficiency.
- Do not run package tests/typecheck/build in parallel when they trigger `npm --prefix ../sdk run build`; the SDK clean build can race on `packages/sdk/dist`.
- Existing untracked directory `docs/plans/haven-landing-audit-2026-06-04/` was present before this run and is unrelated.

## Recommended Next Target

After this PR merges, choose a narrow backend allowance-parity target: audit older `/self-sign-agents` allowance create/update/delete paths against the shared owner-side allowance validation now used by `/agents` and Connect Agent 2 setup. Keep it validation-only and defer broader onboarding, budget UI, or allowance-state rewrites.
