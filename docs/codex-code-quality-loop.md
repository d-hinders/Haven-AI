# Haven Code Quality Loop

Last updated: 2026-06-06

## Current Run

- Branch: `codex/quality-self-sign-delete-lifecycle`
- PR target: align whole-agent `/self-sign-agents/:id` delete behavior with `/agents` by requiring revocation before deletion.
- Why this target: frontend copy and active `/agents` already treat deletion as a cleanup step after network authority has been revoked. The legacy self-sign route still allowed deleting active rows, which could remove Haven's local record before the revocation lifecycle was complete. This PR keeps the change lifecycle-only and does not alter signing, custody, Safe permissions, allowance validation, or UI.
- Files touched: `packages/backend/src/routes/self-sign-agents.ts`, `packages/backend/src/routes/__tests__/self-sign-agents.test.ts`, and this loop file.

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
- PR #272: one-shot x402 and MPP/generic machine-payment writes are terminal-state guarded for signature recording, stale sign-data refresh, confirmed transition, failed transition, and rail-scoped idempotency replay.
- Antonio PR #273: `useSafeOperationGate` now requires both wallet `address` and `walletClient` before treating EOA signing as ready, keeping wallet recovery visible when the client is not ready.
- PR #274: durable review memory now captures the signer-readiness gate trap from PR #273 in `docs/ai-review-patterns.md`, the Captain Self-Check Preflight, and the Haven reviewer prompt.
- PR #275: older `/self-sign-agents` allowance writes use the shared owner-side allowance normalizer and block revoked-agent allowance mutations.
- Planned current PR: whole-agent `/self-sign-agents/:id` delete now requires `status = 'revoked'`, matching `/agents`.
- Prior roadmap exists at `docs/plans/code-quality-roadmap.md`; use this file as the running handoff for the small-PR quality loop going forward.

## Deferred Items

- x402/generic machine-payment consolidation: defer because it crosses idempotency, approval-state, expected-context binding, and multi-entrypoint behavior.
- Broader payment state rewrite, DB migrations, custody/signing semantics, Safe ownership assumptions, production chain/token config, and protocol compatibility changes need separate review.
- Broader x402/payment-history consolidation remains deferred.
- Broader self-sign onboarding, budget UI, and allowance-state rewrites remain deferred.
- Reconciliation-event immutability is deferred: `machine_payment_reconciliation_events` can reopen a resolved event on conflict today, but this PR stays scoped to self-sign delete lifecycle parity.

## Known Baseline Notes

- Focused check after implementation:
  - `npm run test -w packages/backend -- self-sign-agents.test.ts agents.test.ts` passed.
  - `npm run test -w packages/backend` passed.
  - `npm run typecheck -w packages/backend` passed.
  - `npm run build -w packages/backend` passed.
  - `git diff --check` passed.
- Current target scan:
  - Confirmed `/agents` deletes only `status = 'revoked'` rows, returns 404 for missing rows, and returns 409 for existing non-revoked rows.
  - Confirmed `/self-sign-agents` previously deleted by id/user only.
  - Confirmed frontend delete copy already says deletion is only available after revocation, so no product copy change is needed.
- Captain self-check covered CASP guardrails, payment authority boundaries, delete/revoke lifecycle ordering, and focused route regression coverage.
- Do not run package tests/typecheck/build in parallel when they trigger `npm --prefix ../sdk run build`; the SDK clean build can race on `packages/sdk/dist`.
- Existing untracked directory `docs/plans/haven-landing-audit-2026-06-04/` was present before this run and is unrelated.

## Recommended Next Target

After this PR merges, choose a narrow backend payment-state target: harden `machine_payment_reconciliation_events` conflict handling so an already resolved event cannot be reopened by a later retry/upsert. Keep it event-state-only and defer broader payment reconciliation or terminal-state rewrites.
