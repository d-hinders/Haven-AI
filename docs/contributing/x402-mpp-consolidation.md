---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/routes/machine-payments.ts
  - packages/backend/src/routes/x402.ts
  - packages/backend/src/lib/machine-payments.ts
  - packages/backend/src/lib/payment-coverage.ts
  - packages/backend/src/lib/__tests__/payment-coverage.test.ts
  - packages/backend/src/lib/__tests__/resolve-payment-token.test.ts
  - packages/backend/src/routes/__tests__/x402-consolidation.characterization.test.ts
  - packages/backend/src/routes/__tests__/x402.test.ts
  - packages/backend/src/routes/__tests__/machine-payments.test.ts
  - docs/contributing/ai-agent-workflow.md
last-verified: "2026-07-01"
---

# x402 / Machine-Payment Consolidation (PT-1)

Status: **complete**. PRs #517–#521 merged on 2026-06-22. This is a record of
the resulting shared contract, not an active implementation plan.

## Current design

The x402 and generic/MPP money paths share four policy-first primitives:

- `decideCoverage` selects execute, queue, or insufficient coverage.
- `createMachineApproval` writes approval requests.
- `createPaymentIntent` writes payment intents.
- `resolvePaymentToken` resolves supported token configuration.

Thin rail-specific handlers retain x402 binding and one-shot execution, MPP
challenge handling, response shapes, deep validation, and rail-specific
idempotency lookup. The consolidation deliberately avoided a
conditional-heavy common handler.

## Coverage strategies

`decideCoverage` has two explicit strategies:

- **Balance-aware (x402):** execute at or below remaining allowance; queue when
  the amount is above remaining but within remaining plus delegate balance;
  reject amounts above total coverage.
- **Allowance-only (MPP/generic):** execute at or below remaining allowance;
  queue amounts above it.

Delegate balance is coverage for an approval request, not permission to bypass
the configured allowance.

## Deliberate boundaries

- `x402-resources.ts` is a merchant resource/receipt surface, not a third
  authorization path.
- Deep validation remains in each route because challenge formats,
  chain/network inputs, errors, and response contracts differ.
- Each rail retains its idempotency semantics.
- Payment execution and state-transition tests remain the regression oracle.

The completed sequence added characterization tests, extracted approval and
intent writers, introduced parameterized coverage, and extracted token
resolution. Future changes follow [`ai-agent-workflow.md`](ai-agent-workflow.md)
and its money-path review gate.
