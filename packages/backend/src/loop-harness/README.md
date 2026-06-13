# Allowance differential loop

A **loop-engineering harness** for Haven's single most divergence-prone surface:
the off-chain mirror of on-chain allowance state that drives the
auto-execute-vs-queue routing decision.

## Why this exists

The hard spending limit is enforced on-chain by the audited Safe
AllowanceModule — Haven cannot overspend it. What Haven *does* own, and can get
wrong, is the off-chain **prediction** of remaining allowance used to decide
whether a payment auto-executes or is queued for approval
(`computeEffectiveAllowance` in `../lib/allowance-module.ts`). That logic
re-implements the contract's reset arithmetic off-chain, and the same arithmetic
is implemented a third time in the frontend. Three copies that must agree with a
contract = a drift-bug farm.

This is therefore a **reliability / state-correctness loop**, not a custody loop:
a divergence here causes reverted auto-executes, stuck payment records, or
needless approval friction — not loss of funds.

## How the loop works

The oracle is the real contract; the loop hunts for inputs where Haven's mirror
disagrees with what the chain would enforce.

```
generate fuzzed allowance states  ──►  evaluate Haven mirror + reference model
        ▲                                          │
        │                                          ▼
   reproducible seed  ◄── record divergence ──  disagree?
                                                   │ no
                                                   ▼
                                          green ratchet grows
```

### Tier 1 — differential test (`allowance-differential.test.ts`)

Runs anywhere, no network, no Foundry. Pure functions only.

- **`arithmetic equivalence`** — 5,000 deterministic fuzzed cases assert Haven's
  mirror matches `reference-allowance-module.ts` when the relayer clock equals
  chain time. This is the **green ratchet**: if it ever goes red, the off-chain
  reset/decimal math has drifted.
- **`FINDINGS`** — characterised divergences, encoded with `it.fails` so they pin
  the defect in place while keeping the suite green. When the defect is fixed the
  `it.fails` itself goes red — the signal that the loop has converged on that case
  and the finding can be deleted.

Run it:

```bash
npm --prefix packages/backend run test:loop
```

### Tier 2 — fork conformance (`allowance-fork.conformance.test.ts`)

Certifies that the reference model itself matches the live deployed
AllowanceModule, so a Tier-1 divergence can be promoted from *candidate* to
*confirmed*. **Auto-skipped** unless a Gnosis archive/fork RPC is supplied
(needs outbound RPC; full boundary certification needs an anvil fork that can
time-travel). See the header of that file for the exact invocation.

## Running it as a recurring loop

Tier 1 is a fast, deterministic suite — drive it on an interval with the `/loop`
skill, or in CI:

```
/loop 30m npm --prefix packages/backend run test:loop
```

Each iteration: regenerate cases (bump the base seed to widen coverage), run the
diff, and either (a) a new arithmetic divergence turns the ratchet red — triage
and fix, or (b) a fixed defect turns an `it.fails` red — delete the finding. The
loop has a terminal state: green ratchet + zero open findings.

## Findings to date

- **F-1 / F-2 — routing keys off the relayer wall-clock, not chain time.**
  `computeEffectiveAllowance` reads `Date.now()` internally and is not
  time-injectable. Near a reset boundary, clock skew between the backend and the
  chain flips the decision: skew ahead → false auto-execute → on-chain revert
  (demonstrated: Haven `remaining = 500 USDC` while chain `remaining = 0`); skew
  behind → a valid in-budget payment is needlessly queued for approval. The fix
  is to make the reset decision read chain time (e.g. latest `block.timestamp`)
  and to thread that time in as a parameter so it is testable.
```
