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
last-verified: "2026-10-24"
---

# x402 / Machine-Payment Consolidation (PT-1)

Status: **complete**. PRs #517–#521 merged on 2026-06-22. This is a record of
the resulting shared contract, not an active implementation plan.

## Current design

The x402 and generic/MPP money paths shared four policy-first primitives; the last two remain:

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

`decideCoverage` had two explicit strategies:

- **Balance-aware (x402):** execute at or below remaining allowance; queue when
  the amount is above remaining but within remaining plus delegate balance;
  reject amounts above total coverage.
- **Allowance-only (MPP/generic):** execute at or below remaining allowance;
  queue amounts above it.

Delegate balance was coverage for an approval request, not permission to bypass
the configured allowance.

Both strategies applied to the legacy AllowanceModule rail only. #1986 made
that rail fail closed, so every route that reached `decideCoverage` answered
HTTP 410 first, and #1987 then deleted `domain/payment-coverage.ts`,
`decideCoverage` and every caller. The description above records what the
consolidation did, not a path live traffic takes. Delegation-rail requests
(#830) never had a coverage step: they reuse `insertMachineIntent` (with
`execution_rail='delegation'` and a prepared settlement delegation), and
budget, recipient and expiry are enforced on-chain by the caveat enforcers,
with no approval queue. Retired session-rail intents
get HTTP 410 before any coverage decision (#834).

## Deliberate boundaries

- The former `x402-resources.ts` merchant resource/receipt surface was not a
  third authorization path; it was deleted with its last AllowanceModule
  verifier in #2257. The live delegation-rail x402 path remains in `x402.ts`
  and `modules/x402/`.
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
intent/token primitives listed above are UNCHANGED and still live — the route
stopped calling them because its only caller is gone, not because they were
removed. The "Allowance-only (MPP/generic)" coverage strategy did not survive:
it went with `decideCoverage` in #1987. One
primitive has since gone with it: `authorizeMachinePayment` and
`modules/mpp/authorize.ts` were DELETED by #1987 (epic #1440) — the route had
been a `mppDemoRetired()` stub since #1328 and #1986 then 410'd the rail
underneath it, so the 400-line orchestration had no reachable caller left; the
route's refusal lives on in `routes/machine-payments.ts`. The remaining
primitives remain rail-agnostic infrastructure for a possible future
non-demo MPP rail (`mpp_crypto`), which is out of #1328's scope by its own
file-ownership note. Historical `mpp_demo`
payment/receipt/evidence/status rows stay readable through the generic
`/machine-payments/*` reads this document does not otherwise cover.

Re-verified 2026-10-24 (#4372 part D, at dev `f590d946c`). Changed: the
intro and *Coverage strategies* now speak of `decideCoverage` in the past
tense (deleted by #1987, with its two strategies), the #1328 section no longer
calls the "Allowance-only" strategy live, a "below" that pointed at the
paragraph above now says "above", and (review round 1) the paragraph after
*Coverage strategies* states the legacy branch and the delegation rail's lack
of a coverage step in the past tense. Re-checked without change:
`insertMachineIntent` in `infra/repositories/payment-intents.ts`, called with
`executionRail: 'delegation'` from `modules/x402/delegation-authorize.ts`;
`resolvePaymentToken` in `domain/payment-token.ts`; the deleted files
(`domain/payment-coverage.ts`, `infra/repositories/approval-requests.ts`,
`modules/mpp/authorize.ts`, `routes/demo-mpp.ts`, `routes/x402-resources.ts`);
`POST /machine-payments/authorize` answering through `mppDemoRetired()` in
`routes/machine-payments.ts`; and #830, #834, #1328, #1986, #1987, #2055 and
#2257, all closed.
