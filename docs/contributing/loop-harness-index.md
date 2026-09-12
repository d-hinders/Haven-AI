---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/infra/chain/relayer-reads.ts
  - packages/backend/src/modules/mpp/**
  - packages/backend/package.json
  - packages/frontend/package.json
  - .github/workflows/ci.yml
last-verified: "2026-09-11"
---

# Loop Harness Index

Last updated: 2026-09-11 (#2848)

The portfolio of **oracle-grounded differential loops** in this repo — see
[`loop-engineering.md`](./loop-engineering.md) for the concept and the template.
Each row is a permanent harness that runs in CI as a regression/drift guard.

> A loop is a campaign against *one* surface that has an oracle; you accumulate
> many, each with its own harness. This index keeps them discoverable instead of
> scattered across packages.

## Live loops

### ~~LP-1 · Backend allowance routing math~~ — WITHDRAWN (#2020)

**WITHDRAWN (#2020, epic #1440).** The target — `computeEffectiveAllowance` in
the backend's shared chain-read module (`packages/backend/src/infra/chain/relayer-reads.ts`;
named `packages/backend/src/rails/allowance-module.ts` until #2850 renamed it) — is
deleted along with its
last consumer: #1987 had kept it alive only because `GET
/machine-payments/allowances` still read it (#1986's left-readable decision),
and #2020 reversed that decision on a recorded owner call — the endpoint now
answers the fail-closed 410 on the retired rail. With zero production callers
there was nothing left to guard, so the function, the reference model, the
harness (`packages/backend/src/loop-harness/`) and the `test:loop` script were
removed together — the same treatment #1987 gave `decideCoverage`. The loop's
converged findings (F-1/F-2: routing keyed off relayer wall-clock instead of
chain `block.timestamp`) remain a good story in git history; the frontend twin
of the arithmetic lives on under LP-2.

### ~~LP-2 · Frontend allowance display math~~ — WITHDRAWN (#2848)

**WITHDRAWN (#2848, epic #1440).** The target — `computeEffectiveAllowance`
in `packages/frontend/src/lib/allowance-math.ts` — is deleted together with
its reference model and harness (`packages/frontend/src/lib/loop-harness/`):
the historical `AllowanceBar` renderer that read it had no live Safe data
consumer and no render path, so the convergence finding below stood against a
component nothing rendered. The loop's converged findings (F-1/F-2: reset
prediction keyed off the device clock; F-3: `nextResetTime` hardcoded
`lastReset + 2*period`, wrong for multi-period-idle allowances — both resolved
in PR #383 by threading explicit chain `nowSec` and computing the next reset
on the period grid) remain a good story in git history. With the display math
retired there is no frontend allowance loop; the dashboard's budget rows
render the delegation rail's signed terms and carry no reset arithmetic at all.

## Candidate next targets

Surfaces that mirror/predict a source of truth and are bug-prone. A loop is only
viable once its **oracle is named** — the "oracle to define" column is the gating
work.

| Candidate | Where | Oracle to define | Notes |
| --- | --- | --- | --- |
| ~~x402 coverage branching~~ | ~~`packages/backend/src/domain/payment-coverage.ts` (`decideCoverage`)~~ | — | **WITHDRAWN (#1987).** The file is deleted: coverage arithmetic was the AllowanceModule rail's, and the delegation rail does none — budget is metered on-chain by the caveat enforcers. There is nothing left to build a differential loop against. |
| ~~x402 tx verification decoder~~ | ~~`packages/backend/src/infra/chain/allowance-transfer-verifier.ts` (#994 extraction)~~ | — | **WITHDRAWN (#2257).** The final AllowanceModule decoder and its only Haven-as-merchant caller were deleted because no live caller can create or verify this retired transfer shape. The live delegation-rail x402 path uses `settlement-transfer-verifier.ts` instead. |
| ~~Approval-flow state machine~~ | ~~`packages/backend/src/modules/mpp/**`~~ | — | **WITHDRAWN (#1987).** The approval queue was legacy-rail-only; `modules/mpp/authorize.ts` is deleted and the delegation rail has no approval queue at all. |

## Maintenance notes

- When you open or converge a loop, update this file and the harness
  `README.md` findings log in the same change.
