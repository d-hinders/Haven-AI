# Frontend allowance differential loop

The frontend twin of `packages/backend/src/loop-harness`. It targets the
dashboard's off-chain mirror of on-chain allowance state — the third copy of the
AllowanceModule reset arithmetic — and hunts for inputs where it disagrees with
what the contract would enforce.

## Why this exists

`computeEffectiveAllowance` (now in `../allowance-math`) drives the historical
allowance-meter rendering. It re-implements the contract's reset logic
off-chain. Because it is a *display* helper (not an execution decision), a
divergence here is a UI-accuracy bug, not a fund-safety bug. The dashboard's
live delegation budget display uses signed delegation terms instead.

## How the loop works

Same shape as the backend: a seeded fuzzer generates allowance states, and the
mirror is compared against `reference-allowance-module.ts` (the oracle, a
hand-derived port of the contract's reset/grid arithmetic).

- **`arithmetic equivalence`** — 5,000 deterministic cases assert the mirror
  matches the reference at the same chain time. The green ratchet.
- **`regression guards`** — converged findings, kept permanent.

The test lives under `__tests__/` so the frontend's normal `npm test` picks it
up. It is pure (no viem / no DOM), which is why the arithmetic was extracted into
the dependency-light `../allowance-math` module.

Run it:

```bash
npm --prefix packages/frontend test -- src/lib/loop-harness
```

### The reference model is not machine-certified

Like the backend, the oracle is hand-derived from the AllowanceModule source,
not checked against the live deployment. Clock-source divergences are confirmed
bugs regardless; any other new divergence is a candidate to triage by hand.

## Findings log

- **F-1 / F-2 — reset prediction keyed off the user's device clock.**
  *Status: RESOLVED.* `computeEffectiveAllowance` read `Date.now()` internally,
  so near a reset boundary a skewed device clock made the historical dashboard show a
  phantom "reset pending — full allowance" (or hide a real reset). Fix: the
  function now takes an explicit `nowSec` chain timestamp; callers provide the
  same chain-time basis as the allowance snapshot.

- **F-3 — `nextResetTime` wrong for multi-period-idle allowances.**
  *Status: RESOLVED.* The old code hardcoded the next reset at
  `lastReset + 2*period`, correct only when exactly one period was idle. For an
  allowance idle several periods it pointed at a boundary in the past (observed:
  a 3-period-idle daily allowance showed next-reset **2 days early**). Fix: the
  next reset is now computed on the period grid
  (`lastReset + (elapsedPeriods + 1) * period`), matching the contract's
  re-anchoring of `lastResetMin`.

> Note: the **backend** copy of this arithmetic was the first loop target and is
> already fixed; this closes the frontend instance. A shared module across
> packages would collapse the two copies into one — a possible future cleanup.
