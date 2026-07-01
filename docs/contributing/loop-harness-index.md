---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/lib/allowance-module.ts
  - packages/backend/src/loop-harness/**
  - packages/frontend/src/lib/allowance-math.ts
  - packages/frontend/src/lib/loop-harness/**
  - packages/backend/src/lib/payment-coverage.ts
  - packages/backend/src/lib/machine-payments.ts
  - packages/backend/src/routes/x402-resources.ts
  - packages/backend/package.json
  - packages/frontend/package.json
  - .github/workflows/ci.yml
last-verified: "2026-07-01"
---

# Loop Harness Index

Last updated: 2026-07-01

The portfolio of **oracle-grounded differential loops** in this repo — see
[`loop-engineering.md`](./loop-engineering.md) for the concept and the template.
Each row is a permanent harness that runs in CI as a regression/drift guard.

> A loop is a campaign against *one* surface that has an oracle; you accumulate
> many, each with its own harness. This index keeps them discoverable instead of
> scattered across packages.

## Live loops

### LP-1 · Backend allowance routing math

- **Target:** `computeEffectiveAllowance` in `packages/backend/src/lib/allowance-module.ts` — drives auto-execute-vs-queue routing.
- **Oracle:** reference model of the Safe AllowanceModule reset semantics (`packages/backend/src/loop-harness/reference-allowance-module.ts`). Not yet machine-certified against the live contract (clock-source divergences are still confirmed bugs regardless).
- **Harness:** `packages/backend/src/loop-harness/`
- **Run:** `npm --prefix packages/backend run test:loop`
- **Status:** ✅ Converged (green ratchet, 0 open findings).
- **Findings:** F-1/F-2 — routing keyed off the relayer wall-clock (`Date.now()`) instead of chain `block.timestamp`; clock skew flipped the decision (false auto-execute → on-chain revert). *Resolved* (PR merged): function takes an explicit `nowSec` sourced from `getLatestBlockTimeSec`; locked by a regression guard.

### LP-2 · Frontend allowance display math

- **Target:** `computeEffectiveAllowance` in `packages/frontend/src/lib/allowance-math.ts` — drives the dashboard `AllowanceBar`.
- **Oracle:** reference model of the AllowanceModule reset/period-grid semantics (`packages/frontend/src/lib/loop-harness/reference-allowance-module.ts`). Same certification caveat as LP-1.
- **Harness:** `packages/frontend/src/lib/loop-harness/`
- **Run:** `npm --prefix packages/frontend test -- src/lib/loop-harness`
- **Status:** ✅ Converged (green ratchet, 0 open findings).
- **Findings:** F-1/F-2 — reset prediction keyed off the user's *device* clock (phantom reset / hidden reset near a boundary). F-3 — `nextResetTime` hardcoded `lastReset + 2*period`, wrong for multi-period-idle allowances (observed: reset shown ~2 days early). Both *resolved* (PR #383): explicit chain `nowSec` threaded from `useOnChainAllowances`; next reset computed on the period grid.

## Candidate next targets

Surfaces that mirror/predict a source of truth and are bug-prone. A loop is only
viable once its **oracle is named** — the "oracle to define" column is the gating
work.

| Candidate | Where | Oracle to define | Notes |
| --- | --- | --- | --- |
| x402 coverage branching | `packages/backend/src/lib/payment-coverage.ts` (`decideCoverage`) | invariant set over `delegateBalance + remaining` vs requested amount | bespoke Haven logic, no on-chain backstop on the merchant leg |
| x402 tx verification decoder | `packages/backend/src/routes/x402-resources.ts` (`_verifyTx`) | AllowanceModule calldata spec (decode `executeAllowanceTransfer`) | parsing/validation surface |
| Approval-flow state machine | `packages/backend/src/lib/machine-payments.ts` | invariant: no `executed` record without a tx hash; over-limit never auto-executes | property/invariant shape, not differential |

## Maintenance notes

- LP-1 and LP-2 are two copies of the *same* arithmetic with two reference
  models. A shared cross-package module would collapse them into one oracle — a
  worthwhile future cleanup (the two `EffectiveAllowance` types differ: the
  frontend adds `nextResetTime`).
- Neither reference model is certified against the live deployed contract. If a
  fork-conformance tier is ever added (anvil + Gnosis fork), certify both models
  there and remove the "candidate finding" caveat from the READMEs.
- When you open or converge a loop, update this file and the harness `README.md`
  findings log in the same change.
