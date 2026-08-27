---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/rails/allowance-module.ts
  - packages/frontend/src/lib/allowance-math.ts
  - packages/frontend/src/lib/loop-harness/**
  - packages/backend/src/modules/mpp/**
  - packages/backend/src/routes/x402-resources.ts
  - packages/backend/package.json
  - packages/frontend/package.json
  - .github/workflows/ci.yml
last-verified: "2026-08-27" # #2117: a file this doc covers by glob (`modules/mpp/evidence.ts`) — `recordMachinePaymentEvidenceBase` now RETURNS whether a `machine_payment_evidence` row was written, for the passive erc7710 settlement observer; the loop-harness pointers are otherwise unchanged. Scope: that return-value addition only. Prior: #2020: LP-1 WITHDRAWN — its target computeEffectiveAllowance lost its last caller when GET /machine-payments/allowances went 410 on the retired rail (owner reversal of #1986); function, harness and test:loop script deleted together, maintenance notes updated to LP-2-only. Prior: #1987: re-read against the AllowanceModule deletion. LP-1 STAYS and its target survives, but its stated purpose was wrong post-deletion (it drives the allowances report, not routing) — corrected. `domain/payment-coverage.ts` dropped from `covers:` (deleted), and two of the three candidate loops withdrawn because their surfaces are gone. LP-2 (frontend) untouched — that is #1989. Prior: re-verified for #1251 (MPP seam refusal) — no claim here affected
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

### ~~LP-1 · Backend allowance routing math~~ — WITHDRAWN (#2020)

**WITHDRAWN (#2020, epic #1440).** The target — `computeEffectiveAllowance` in
`packages/backend/src/rails/allowance-module.ts` — is deleted along with its
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
| ~~x402 coverage branching~~ | ~~`packages/backend/src/domain/payment-coverage.ts` (`decideCoverage`)~~ | — | **WITHDRAWN (#1987).** The file is deleted: coverage arithmetic was the AllowanceModule rail's, and the delegation rail does none — budget is metered on-chain by the caveat enforcers. There is nothing left to build a differential loop against. |
| x402 tx verification decoder | `packages/backend/src/infra/chain/allowance-transfer-verifier.ts` (#994 extraction) | AllowanceModule calldata spec (decode `executeAllowanceTransfer`) | parsing/validation surface. #1987: the decoder survives — it verifies HISTORICAL inbound transfers for `POST /x402/resources/:id/verify`, which is Haven-as-merchant, not the retired spend path. Weak candidate now that no new such transfers can be created. |
| ~~Approval-flow state machine~~ | ~~`packages/backend/src/modules/mpp/**`~~ | — | **WITHDRAWN (#1987).** The approval queue was legacy-rail-only; `modules/mpp/authorize.ts` is deleted and the delegation rail has no approval queue at all. |

## Maintenance notes

- LP-2 is now the only copy of the reset arithmetic (LP-1's backend twin was
  deleted with its target, #2020), so the old collapse-into-one-oracle cleanup
  is moot.
- LP-2's reference model is not certified against the live deployed contract.
  If a fork-conformance tier is ever added (anvil + fork), certify it there and
  remove the "candidate finding" caveat from its README.
- When you open or converge a loop, update this file and the harness `README.md`
  findings log in the same change.
