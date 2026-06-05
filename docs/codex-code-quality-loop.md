# Haven Code Quality Loop

Last updated: 2026-06-05

## Current Run

- Branch: `codex/quality-machine-payment-submitted-state`
- PR target: prevent one-shot machine-payment authorizations from marking an intent `submitted` before on-chain execution returns a transaction hash.
- Why this target: it is a narrow P0 payment-state hardening change, mirrors the safer x402 route behavior, and reduces stuck-payment risk without changing custody, signer, protocol, API, or UX semantics.
- Files touched: `packages/backend/src/lib/machine-payments.ts`, `packages/backend/src/routes/__tests__/machine-payments.test.ts`, and this loop file.

## Priority Backlog

- P0: Agent payment flow state hardening, especially x402/MPP idempotency, retry, approval-resume, and terminal-state behavior.
- P0: Agent credential handoff safety, including local credential file validation and secret redaction in generated artifacts, logs, errors, and tests.
- P0: Wallet/account setup readiness checks, including network, Safe deployment, funding, and chain/token mismatch handling.
- P0: Agent budget and policy flow consistency across allowance creation, remaining budget display, pause/revoke, and on-chain/account state.
- P1: Backend/API validation, error responses, logging safety, and shared response type coverage.
- P1: Test infrastructure reliability, especially avoiding hidden clean-build races and making local gates match CI.

## Completed Areas

- Planned current PR: machine-payment one-shot signature recording no longer sets `submitted` before RPC execution; regression coverage asserts the pre-RPC SQL and call order.
- Prior roadmap exists at `docs/plans/code-quality-roadmap.md`; use this file as the running handoff for the small-PR quality loop going forward.

## Deferred Items

- x402 decimal atomic amount validation in SDK and backend: reject `0x`, scientific notation, signed, negative, blank, or whitespace-wrapped atomic strings before signing, idempotency, allowance checks, or DB writes.
- MPP demo `expiresAt` validation: reject invalid timestamps instead of letting `NaN` bypass the expiry check.
- x402/generic machine-payment consolidation: defer because it crosses idempotency, approval-state, expected-context binding, and multi-entrypoint behavior.
- Broader payment state rewrite, DB migrations, custody/signing semantics, Safe ownership assumptions, production chain/token config, and protocol compatibility changes need separate review.

## Known Baseline Notes

- Baseline checks from this run before implementation:
  - `npm run test -w packages/sdk -- x402.test.ts` passed.
  - `npm run typecheck -w packages/sdk` passed.
  - `npm run test -w packages/backend -- machine-payments.test.ts` passed.
  - `npm run typecheck -w packages/backend` passed when run serially.
- Do not run backend tests/typecheck in parallel when both trigger `npm --prefix ../sdk run build`; the SDK clean build can race on `packages/sdk/dist`.
- Existing untracked directory `docs/plans/haven-landing-audit-2026-06-04/` was present before this run and is unrelated.

## Recommended Next Target

After this PR merges, choose the next highest safe P0 target: x402 decimal atomic amount validation across SDK parsing/selection and backend `/x402` authorization tests. Keep it validation-only, with no protocol compatibility changes beyond rejecting malformed decimal atomic strings.
