---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/routes/machine-payments.ts
  - packages/backend/src/routes/x402.ts
  - packages/backend/src/modules/mpp/**
  - packages/backend/src/domain/payment-token.ts
  - packages/backend/src/domain/__tests__/payment-token.test.ts
  - packages/backend/src/routes/__tests__/x402-consolidation.characterization.test.ts
  - packages/backend/src/routes/__tests__/x402.test.ts
  - packages/backend/src/routes/__tests__/machine-payments.test.ts
  - docs/contributing/ai-agent-workflow.md
last-verified: "2026-08-27" # #2102: the Current design list described `decideCoverage` selecting "execute, queue, or insufficient coverage" in the present tense. The file and helper were DELETED by #1987 (and removed from the money-path glob list in the same change) — verified by grep: zero references repo-wide. Annotated inline and put in the past tense, matching the treatment the very next bullet already gives `insertMachineApproval`. That inconsistency is why this read as ambiguous archaeology rather than a defect. Scope: that one bullet. Prior: #2055: insertMachineApproval + approval-requests.ts recorded as deleted with the table. Prior: #1987: the Coverage-strategies section said `decideCoverage`'s code was "still present (deleted by #1987)" — it has now been deleted outright, with `domain/payment-coverage.ts` and every caller, so the claim is corrected to past tense. Dead `covers:` globs for the module and its test removed. The shared-primitive boundary claims re-read and unaffected. Prior: #1986: decideCoverage's legacy branch is now unreachable in production — every caller refuses upstream with 410. Noted; the delegation-rail branch and the shared-primitive boundaries re-read against the diff and unchanged. Prior: #1328 — mpp_demo route retired, shared primitives unchanged (see new section) + same-day dev: re-verified for #1355 (payment_id-only signing: payment_required persisted in machine_metadata + re-served by sign-context; grep-checked: no claim here names the sign-call argument shape; sequence/authority claims unaffected)
---

# x402 / Machine-Payment Consolidation (PT-1)

Status: **complete**. PRs #517–#521 merged on 2026-06-22. This is a record of
the resulting shared contract, not an active implementation plan.

## Current design

The x402 and generic/MPP money paths share four policy-first primitives:

- `decideCoverage` (`src/domain/payment-coverage.ts` — file and helper both
  DELETED by #1987, and removed from the money-path glob list with it)
  selected execute, queue, or insufficient coverage.
- `insertMachineApproval` (`infra/repositories/approval-requests.ts` — file
  and helper both DELETED with the table by #2055) wrote
  approval requests — called directly by both modules since #997 removed the
  `lib/machine-payments.createMachineApproval` pass-through, which added no
  logic over this repository call.
- `insertMachineIntent` (`infra/repositories/payment-intents.ts`) writes
  payment intents, same story (`createPaymentIntent` removed by #997).
- `resolvePaymentToken` (`src/domain/payment-token.ts` since #997) resolves
  supported token configuration.

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

Both strategies apply to the legacy AllowanceModule rail only — and since
#1986 that rail fails closed, so `decideCoverage`'s legacy branch is
**unreachable in production traffic**: every route that used to reach it now
answers HTTP 410 first. The description below is kept because the code is
**deleted by #1987** — `domain/payment-coverage.ts` and `decideCoverage`
are gone, along with every caller; it documents what the consolidation did, not
a path live traffic takes. Delegation-rail
requests (#830) branch before coverage: they reuse `insertMachineIntent` (with
`execution_rail='delegation'` and a prepared settlement delegation) but skip
`decideCoverage` entirely — budget, recipient, and expiry are enforced on-chain
by the caveat enforcers, with no approval queue. Retired session-rail intents
get HTTP 410 before any coverage decision (#834).

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
and its money-path review bar.

## #1328: the mpp_demo route retired, the shared primitives did not

`POST /machine-payments/authorize` now refuses unconditionally (410) — the
`mpp_demo` demo flow it served (`routes/demo-mpp.ts`) is retired outright. The
"Allowance-only (MPP/generic)" coverage strategy above, `authorizeMachinePayment`
(`modules/mpp/authorize.ts`), and the four shared primitives it lists are
UNCHANGED and still live — the route stopped calling them because its only
caller is gone, not because they were removed. They remain rail-agnostic
infrastructure for a possible future non-demo MPP rail (`mpp_crypto`), which
is out of #1328's scope by its own file-ownership note. Historical `mpp_demo`
payment/receipt/evidence/status rows stay readable through the generic
`/machine-payments/*` reads this document does not otherwise cover.
