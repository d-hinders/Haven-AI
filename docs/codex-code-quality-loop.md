# Haven Code Quality Loop

Last updated: 2026-06-05

## Current Run

- Branch: `codex/quality-mpp-expiry-validation`
- PR target: reject invalid MPP demo challenge `expiresAt` values before authorization work begins.
- Why this target: it is a narrow payment-route validation hardening item that prevents malformed challenge timestamps from bypassing expiry checks without changing merchant/demo scope, protocol behavior, custody, signer, Safe ownership, or API shape.
- Files touched: `packages/backend/src/routes/machine-payments.ts`, `packages/backend/src/routes/__tests__/machine-payments.test.ts`, and this loop file.

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
- Planned current PR: MPP demo challenge validation rejects invalid `expiresAt` timestamps before authorization, allowance, hash, or execution helpers run.
- Prior roadmap exists at `docs/plans/code-quality-roadmap.md`; use this file as the running handoff for the small-PR quality loop going forward.

## Deferred Items

- x402/generic machine-payment consolidation: defer because it crosses idempotency, approval-state, expected-context binding, and multi-entrypoint behavior.
- Broader payment state rewrite, DB migrations, custody/signing semantics, Safe ownership assumptions, production chain/token config, and protocol compatibility changes need separate review.

## Known Baseline Notes

- Baseline checks from this run before implementation:
  - `npm run test -w packages/backend -- machine-payments.test.ts` passed.
- Do not run backend tests/typecheck in parallel when both trigger `npm --prefix ../sdk run build`; the SDK clean build can race on `packages/sdk/dist`.
- Existing untracked directory `docs/plans/haven-landing-audit-2026-06-04/` was present before this run and is unrelated.

## Recommended Next Target

After this PR merges, choose a narrow P0 credential-handoff safety target: inspect `packages/mcp/src/credentials.ts` and related tests for malformed/partial credential handling and secret redaction opportunities. Keep it validation/test-focused and do not change key custody, generation, export/import, or signer semantics.
