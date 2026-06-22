# x402 / Machine-Payment Consolidation (PT-1)

Status: **in progress** — characterization stage. Owner: captain.
Started: 2026-06-22. Tracking: `docs/contributing/code-quality-loop.md` → PT-1.

## Why

Haven moves money through **two parallel implementations** of the same
policy-first decision (auto-execute vs. queue-for-approval vs. reject):

| Path | Decision + execution | Approval row write |
| --- | --- | --- |
| `routes/machine-payments.ts` (MPP / generic) | `lib/machine-payments.authorizeMachinePayment` (shared core) | shared core |
| `routes/x402.ts` (legacy x402) | **inline** in the route handler | **inline** |
| `routes/x402-resources.ts` | partial third variant (`_verifyTx`, coverage) | inline |

Five files write `payment_intents` / `approval_requests`; four route files
independently decide routing. Every correctness or security fix to money routing
has to be made in multiple places and drifts — the loop history already shows
guards landing on one path but not the other. This is Haven's core
non-negotiable (policy-first execution) implemented 2–3 times. Collapsing it onto
one core is the highest-leverage correctness work available.

## What is actually shared vs. genuinely different

This is **not** a delete-the-duplicate job. The paths diverge for real reasons:

- **Coverage model (genuine divergence — must be preserved as an option):**
  - `x402` reads the **delegate balance** and routes on
    `totalCoverage = delegateBalance + remaining`:
    `amount > totalCoverage` → **422 insufficient_funds**; a small overage the
    delegate's existing balance can cover **falls through to execute**. This
    exists because of the x402 hot-wallet funding leg (the delegate EOA briefly
    holds liquid funds).
  - `authorizeMachinePayment` has **no balance pre-flight**:
    `amount > remaining` → queue. Full stop.
  - ⇒ The unified core must treat the coverage decision as a **parameterized
    strategy** (`balance-aware` for x402, `allowance-only` for MPP), not hardcode
    one. **Open product/security decision for the captain:** is the balance-aware
    pre-flight x402-only forever, or should MPP adopt it? Default assumption:
    x402-only, parameterized.

- **Approval-row INSERT (lib is the superset):** the `authorizeMachinePayment`
  INSERT parameterizes `source` / `payment_rail` and includes
  `machine_challenge_id`; the x402 inline INSERT hardcodes `source='x402'` /
  `payment_rail='x402'` and omits `machine_challenge_id`. ⇒ x402's row is a
  special case of the lib's. The shared helper is the lib form, called with
  `rail='x402'`, `source='x402'`, `challengeId=null`.

- **Genuinely shared (the extraction targets):** input validation (token, amount,
  addresses, chain match), idempotency lookup (`findExistingIntent` /
  `findExistingApproval`), approval-row creation, transfer-hash generation
  (`generateTransferHash`), and intent persistence.

## PR sequence

Each PR is independently shippable, behavior-preserving, and gated on the full
backend suite + `tsc --noEmit`. Money paths: no auto-merge.

1. **Characterization (this PR).** Pin the contract the extraction must preserve:
   the exact x402 approval-row column set + `ON CONFLICT` target, the structural
   divergence (x402 omits `machine_challenge_id`), and that the x402 coverage
   decision is balance-aware (consults delegate balance). No runtime change.
2. **Extract shared approval creation.** Lift the lib's approval INSERT into
   `createMachineApproval(...)`; route both `lib/machine-payments` and
   `routes/x402` through it. x402 passes `rail/source='x402'`, `challengeId=null`.
   Characterization from PR1 proves the x402 row is unchanged.
3. **Extract the coverage decision** as a parameterized strategy
   (`decideRouting({ amount, remaining, delegateBalance? })` →
   `execute | queue | insufficient`), with `balance-aware` vs `allowance-only`
   variants. Hand this to an **oracle-grounded loop** (it is the
   `loop-harness-index.md` "x402 coverage branching" candidate) — it has a clean
   invariant set and is the highest-value differential surface.
4. **Route `/x402` onto `authorizeMachinePayment`**, passing the balance-aware
   strategy + x402 metadata. Delete the inline decision/execution. The existing
   x402 HTTP suite is the regression gate.
5. **Fold in `x402-resources.ts`** and retire the last inline variant; collapse
   the duplicated `payment_intents` writers.

## Acceptance gate (every PR)

- `npm run test -w packages/backend` green (full suite — both x402 and
  machine-payment suites are the regression oracle).
- `npm run typecheck -w packages/backend` (`tsc --noEmit`) exit 0.
- `haven-reviewer` pass before PRs 3–5 (they touch the routing decision and
  execution); PRs 1–2 are test-only / mechanical extraction.
