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
is implemented again in the frontend. Multiple copies that must agree with a
contract = a drift-bug farm.

This is therefore a **reliability / state-correctness loop**, not a custody loop:
a divergence here causes reverted auto-executes, stuck payment records, or
needless approval friction — not loss of funds.

## How the loop works

The reference model stands in for the contract; the loop hunts for inputs where
Haven's mirror disagrees with what the chain would enforce.

```
generate fuzzed allowance states  ──►  evaluate Haven mirror + reference model
        ▲                                          │
        │                                          ▼
   reproducible seed  ◄── record divergence ──  disagree?
                                                   │ no
                                                   ▼
                                          green ratchet grows
```

### Differential test (`allowance-differential.test.ts`)

Runs anywhere, no network, no Foundry. Pure functions only.

- **`arithmetic equivalence`** — 5,000 deterministic fuzzed cases assert Haven's
  mirror matches `reference-allowance-module.ts` when both are evaluated at the
  same chain time. This is the **green ratchet**: if it ever goes red, the
  off-chain reset/decimal math has drifted from the contract's.
- **`regression guards`** — converged findings, kept as permanent tests so a
  fixed defect cannot silently return.

Run it:

```bash
npm --prefix packages/backend run test:loop
```

### The reference model is not yet machine-certified

`reference-allowance-module.ts` is the oracle, but it is hand-derived from the
AllowanceModule source — it is **not** automatically checked against the live
deployed contract (that would need a forked-chain conformance run, which this
repo does not currently set up). Consequences:

- A divergence caused purely by the **clock source** is a confirmed bug
  regardless of model fidelity (the contract can only read `block.timestamp`).
- Any other new divergence is a **candidate** finding to triage by hand against
  the contract source until a fork-conformance tier exists.

## Running it as a recurring loop

The suite is fast and deterministic — drive it on an interval with the `/loop`
skill, or in CI:

```
/loop 30m npm --prefix packages/backend run test:loop
```

Each iteration: regenerate cases (bump the base seed to widen coverage) and run
the diff. A new arithmetic divergence turns the ratchet red → triage and fix,
then keep the case as a regression guard. The loop has a terminal state: green
ratchet + zero open findings.

## Findings log

- **F-1 / F-2 — routing keyed off the relayer wall-clock, not chain time.**
  *Status: RESOLVED.* `computeEffectiveAllowance` read `Date.now()` internally
  and was not time-injectable, so near a reset boundary clock skew flipped the
  decision: skew ahead → false auto-execute → on-chain revert (observed: Haven
  `remaining = 500 USDC` while chain `remaining = 0`); skew behind → a valid
  in-budget payment needlessly queued. Fix: `computeEffectiveAllowance` now takes
  an explicit `nowSec` chain timestamp, sourced from `getLatestBlockTimeSec`
  (latest `block.timestamp`) at every call site. Locked in by the
  "reset decision tracks the passed chain time" regression guard.
  - Note: the **frontend** copy of this arithmetic
    (`packages/frontend/src/lib/allowance-module.ts`) is a separate, still-open
    instance of the same wall-clock pattern — a candidate next loop target.
```
