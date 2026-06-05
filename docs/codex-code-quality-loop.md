# Haven Code Quality Loop

Last updated: 2026-06-05

## Current Run

- Branch: `codex/quality-x402-atomic-validation`
- PR target: reject malformed x402 atomic amount strings in SDK selection/helpers and backend `/x402` authorization before signing, idempotency, allowance checks, or DB writes.
- Why this target: it is the next narrow P0 payment-flow validation hardening item, and it avoids protocol, custody, signer, Safe ownership, API-shape, and UX changes.
- Files touched: `packages/sdk/src/x402.ts`, `packages/sdk/src/x402.test.ts`, `packages/backend/src/routes/x402.ts`, `packages/backend/src/routes/__tests__/x402.test.ts`, and this loop file.

## Priority Backlog

- P0: Agent payment flow state hardening, especially x402/MPP idempotency, retry, approval-resume, and terminal-state behavior.
- P0: Agent credential handoff safety, including local credential file validation and secret redaction in generated artifacts, logs, errors, and tests.
- P0: Wallet/account setup readiness checks, including network, Safe deployment, funding, and chain/token mismatch handling.
- P0: Agent budget and policy flow consistency across allowance creation, remaining budget display, pause/revoke, and on-chain/account state.
- P1: Backend/API validation, error responses, logging safety, and shared response type coverage.
- P1: Test infrastructure reliability, especially avoiding hidden clean-build races and making local gates match CI.

## Completed Areas

- PR #258: machine-payment one-shot signature recording no longer sets `submitted` before RPC execution; regression coverage asserts pre-RPC SQL/call order and records `submitted_at` only when a tx hash exists.
- Planned current PR: x402 amount validation rejects hex, scientific notation, signed, negative, zero, blank, and whitespace-wrapped atomic values before payment work begins.
- Prior roadmap exists at `docs/plans/code-quality-roadmap.md`; use this file as the running handoff for the small-PR quality loop going forward.

## Deferred Items

- MPP demo `expiresAt` validation: reject invalid timestamps instead of letting `NaN` bypass the expiry check.
- x402/generic machine-payment consolidation: defer because it crosses idempotency, approval-state, expected-context binding, and multi-entrypoint behavior.
- Broader payment state rewrite, DB migrations, custody/signing semantics, Safe ownership assumptions, production chain/token config, and protocol compatibility changes need separate review.

## Known Baseline Notes

- Baseline checks from this run before implementation:
  - `npm run test -w packages/sdk -- x402.test.ts` passed.
  - `npm run test -w packages/backend -- x402.test.ts` passed.
- Do not run backend tests/typecheck in parallel when both trigger `npm --prefix ../sdk run build`; the SDK clean build can race on `packages/sdk/dist`.
- Existing untracked directory `docs/plans/haven-landing-audit-2026-06-04/` was present before this run and is unrelated.

## Recommended Next Target

After this PR merges, choose the next highest safe target: MPP demo `expiresAt` validation in `packages/backend/src/routes/machine-payments.ts`, with focused route tests proving invalid timestamps are rejected before authorization work. Keep it validation-only and do not broaden merchant/demo facilitator behavior.
