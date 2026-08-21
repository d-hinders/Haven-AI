/**
 * The budget-meter carry (#1698). These are the tests that have to be able to
 * FAIL for the carry to mean anything, so each one names the mutation it
 * catches — see the PR body for the runs.
 */
import { describe, expect, it } from 'vitest'
import {
  CarryRefusedError,
  currentPeriodBoundary,
  planCarry,
  spendableBeforeBoundary,
  type CarryPlan,
  type DelegationTerms,
} from '../rekey-carry.js'

const DAY = 86_400
const BUDGET = 1_000_000n // 1 USDC

/** Anchor everything to a fixed instant — the arithmetic is the subject. */
const T0 = 1_760_000_000

function oldTerms(over: Partial<DelegationTerms> = {}): DelegationTerms {
  return {
    budgetAtomic: BUDGET,
    periodSeconds: DAY,
    startDate: T0,
    expiresAt: T0 + 90 * DAY,
    ...over,
  }
}

function fromChain(remainingAtomic: bigint) {
  return { remainingAtomic, fromChain: true }
}

function assertCarryKind(
  plan: CarryPlan,
): asserts plan is Extract<CarryPlan, { kind: 'carry' }> {
  expect(plan.kind).toBe('carry')
}

describe('currentPeriodBoundary', () => {
  it('returns the end of the period containing now', () => {
    expect(currentPeriodBoundary(oldTerms(), T0 + 1)).toBe(T0 + DAY)
    expect(currentPeriodBoundary(oldTerms(), T0 + DAY - 1)).toBe(T0 + DAY)
    expect(currentPeriodBoundary(oldTerms(), T0 + DAY + 5)).toBe(T0 + 2 * DAY)
  })

  it('treats a boundary instant as the START of the next period, not the end of the last', () => {
    // Half-open periods, matching the enforcer: at exactly startDate + p the
    // refill has happened, so the boundary ahead is one more period out.
    expect(currentPeriodBoundary(oldTerms(), T0 + DAY)).toBe(T0 + 2 * DAY)
  })

  it('is exact at the anchor itself', () => {
    expect(currentPeriodBoundary(oldTerms(), T0)).toBe(T0 + DAY)
  })
})

describe('planCarry — the boundary is carried, not reset', () => {
  it('caps the first period at the remainder AND ends it at the old boundary', () => {
    const now = T0 + 6 * 3600 // six hours into the first period
    const plan = planCarry({ old: oldTerms(), meter: fromChain(400_000n), nowSec: now })
    assertCarryKind(plan)

    expect(plan.boundary).toBe(T0 + DAY)
    expect(plan.carry).toEqual({
      budgetAtomic: 400_000n,
      periodSeconds: DAY,
      // Anchored one period before the boundary, so the carry's CURRENT
      // period is exactly the old one — the agent does not get a fresh clock.
      startDate: T0 + DAY - DAY,
      // Dies at the boundary: it can never refill into a second period.
      expiresAt: T0 + DAY,
    })
  })

  it('MUTATION TARGET — a carry that reset the period instead of carrying it fails here', () => {
    // The tempting-but-wrong implementation anchors the carry at `nowSec`.
    // It gets the AMOUNT right and the boundary wrong, and this assertion is
    // the one that separates them.
    const now = T0 + 6 * 3600
    const plan = planCarry({ old: oldTerms(), meter: fromChain(400_000n), nowSec: now })
    assertCarryKind(plan)

    expect(plan.carry?.startDate).not.toBe(now)
    expect(plan.carry?.startDate).not.toBe(now - 60)
    expect(plan.carry?.expiresAt).toBe(T0 + DAY)
    // A reset period would end a full day after `now`, six hours late.
    expect(plan.carry?.expiresAt).not.toBe(now + DAY)
  })

  it('resumes the original grant, on the original cadence, at the boundary', () => {
    const plan = planCarry({ old: oldTerms(), meter: fromChain(400_000n), nowSec: T0 + 3600 })
    assertCarryKind(plan)

    expect(plan.steady).toEqual({
      budgetAtomic: BUDGET,
      periodSeconds: DAY,
      startDate: T0 + DAY,
      expiresAt: T0 + 90 * DAY,
    })
    // The two never overlap: the carry dies at the instant the steady starts.
    expect(plan.carry?.expiresAt).toBe(plan.steady?.startDate)
  })

  it('works against a PARTIALLY SPENT period, not just a fresh one', () => {
    // The acceptance criterion says this explicitly. A fresh period would
    // pass even an implementation that ignored the meter entirely.
    const plan = planCarry({ old: oldTerms(), meter: fromChain(125_000n), nowSec: T0 + 20 * 3600 })
    assertCarryKind(plan)
    expect(plan.carry?.budgetAtomic).toBe(125_000n)
    expect(plan.carry?.budgetAtomic).not.toBe(BUDGET)
    expect(plan.boundary).toBe(T0 + DAY)
  })

  it('issues no carry when the period is fully spent — and still resumes at the boundary', () => {
    const plan = planCarry({ old: oldTerms(), meter: fromChain(0n), nowSec: T0 + 3600 })
    assertCarryKind(plan)
    // Zero is not a buildable grant, and it is also the honest answer: the
    // agent has nothing left this period. Authority returns at the boundary.
    expect(plan.carry).toBeNull()
    expect(plan.steady?.startDate).toBe(T0 + DAY)
    expect(spendableBeforeBoundary(plan)).toBe(0n)
  })
})

describe('planCarry — the repeated-re-key bypass', () => {
  /**
   * The acceptance criterion: "A re-key attempted twice in the same period
   * cannot yield more total spend than the original period allowed."
   *
   * Simulated end to end in the arithmetic: grant 1 USDC, spend 0.4, re-key,
   * spend 0.3 of the carry, re-key again. Each re-key's input is the terms of
   * the grant it is replacing, which is what a second re-key really reads.
   */
  it('cannot yield more total spend than the original period allowed', () => {
    const now1 = T0 + 3 * 3600
    const first = planCarry({ old: oldTerms(), meter: fromChain(600_000n), nowSec: now1 })
    assertCarryKind(first)
    expect(first.carry?.budgetAtomic).toBe(600_000n)

    // Re-key again, six hours later, having spent 0.3 more of the carry.
    const now2 = T0 + 9 * 3600
    const second = planCarry({
      old: first.carry as DelegationTerms,
      meter: fromChain(300_000n),
      nowSec: now2,
    })
    assertCarryKind(second)

    // The boundary is UNMOVED — this is the whole property. Carrying only
    // the amount would put it at now2 + DAY.
    expect(second.boundary).toBe(first.boundary)
    expect(second.boundary).toBe(T0 + DAY)
    expect(second.carry?.expiresAt).toBe(T0 + DAY)

    // Total spendable inside the original period: 0.4 already spent + 0.3
    // spent from the carry + 0.3 still available = 1.0, the original budget.
    const spent = 400_000n + 300_000n
    expect(spent + spendableBeforeBoundary(second)).toBe(BUDGET)
    expect(spent + spendableBeforeBoundary(second)).toBeLessThanOrEqual(BUDGET)
  })

  it('holds for ten re-keys in one period', () => {
    // The leak the owner decision names is specifically about REPEATED
    // re-keys, so one repetition is not a proof.
    let terms = oldTerms()
    let remaining = BUDGET
    let spentTotal = 0n
    for (let i = 1; i <= 10; i++) {
      remaining -= 50_000n
      spentTotal += 50_000n
      const plan = planCarry({
        old: terms,
        meter: fromChain(remaining),
        nowSec: T0 + i * 600,
      })
      assertCarryKind(plan)
      expect(plan.boundary).toBe(T0 + DAY)
      terms = plan.carry as DelegationTerms
    }
    expect(spentTotal + spendableBeforeBoundary({ kind: 'carry', boundary: T0 + DAY, carry: terms, steady: null })).toBe(BUDGET)
  })
})

describe('planCarry — refusals', () => {
  it('REFUSES a meter reading that did not come from the chain', () => {
    // readRemainingBudget falls back to the FULL budget on a failed read.
    // Carrying that is a fresh full period — the exact leak the boundary
    // carry exists to stop.
    expect(() =>
      planCarry({
        old: oldTerms(),
        meter: { remainingAtomic: BUDGET, fromChain: false },
        nowSec: T0 + 3600,
      }),
    ).toThrow(CarryRefusedError)

    try {
      planCarry({
        old: oldTerms(),
        meter: { remainingAtomic: BUDGET, fromChain: false },
        nowSec: T0 + 3600,
      })
    } catch (err) {
      expect((err as CarryRefusedError).code).toBe('meter_not_from_chain')
    }
  })

  it('refuses a remainder larger than the budget rather than clamping it', () => {
    expect(() =>
      planCarry({ old: oldTerms(), meter: fromChain(BUDGET + 1n), nowSec: T0 + 3600 }),
    ).toThrow(/exceeds the granted budget/)
  })

  it('refuses terms the enforcer could not hold', () => {
    expect(() =>
      planCarry({ old: oldTerms({ periodSeconds: 30 }), meter: fromChain(1n), nowSec: T0 + 10 }),
    ).toThrow(/period_seconds/)
    expect(() =>
      planCarry({ old: oldTerms({ budgetAtomic: 0n }), meter: fromChain(0n), nowSec: T0 + 10 }),
    ).toThrow(/budget_atomic/)
  })
})

describe('planCarry — edge shapes', () => {
  it('carries nothing when the old grant has already expired', () => {
    const plan = planCarry({
      old: oldTerms({ expiresAt: T0 + 100 }),
      meter: fromChain(900_000n),
      nowSec: T0 + 200,
    })
    expect(plan).toEqual({ kind: 'expired' })
  })

  it('re-anchors verbatim when the old grant has not started yet', () => {
    const future = oldTerms({ startDate: T0 + 10 * DAY })
    const plan = planCarry({ old: future, meter: fromChain(BUDGET), nowSec: T0 })
    expect(plan).toEqual({ kind: 'dormant', reissue: future })
  })

  it('MUTATION TARGET — a dormant grant is decided BEFORE the meter refusals', () => {
    // The re-key-of-a-re-key case, found while re-checking the
    // multi-delegation interaction after review. Re-keying an
    // already-re-keyed agent means re-keying its dormant "steady" grant, and
    // a period enforcer asked for the available amount of a delegation whose
    // first period has not started can revert — reported as
    // `fromChain: false`. That reading is meaningless for a grant nothing has
    // spent from, and refusing on it would 409 the entire second re-key.
    //
    // Moving the meter refusals back above the dormant branch makes this
    // throw instead of returning a plan.
    const future = oldTerms({ startDate: T0 + 10 * DAY })
    const plan = planCarry({
      old: future,
      meter: { remainingAtomic: BUDGET, fromChain: false },
      nowSec: T0,
    })
    expect(plan).toEqual({ kind: 'dormant', reissue: future })
  })

  it('an expired grant is likewise decided before the meter refusals', () => {
    const dead = oldTerms({ expiresAt: T0 + 100 })
    expect(
      planCarry({
        old: dead,
        meter: { remainingAtomic: BUDGET, fromChain: false },
        nowSec: T0 + 200,
      }),
    ).toEqual({ kind: 'expired' })
  })

  it('still refuses a fallback reading for a LIVE grant — the refusal is not weakened', () => {
    // The counterpart assertion. Reordering must not have turned the
    // meter_not_from_chain refusal off for the case it exists to catch.
    expect(() =>
      planCarry({
        old: oldTerms(),
        meter: { remainingAtomic: BUDGET, fromChain: false },
        nowSec: T0 + 3600,
      }),
    ).toThrow(CarryRefusedError)
  })

  it('clips the carry to the grant expiry when the grant dies mid-period', () => {
    const dying = oldTerms({ expiresAt: T0 + DAY - 3600 })
    const plan = planCarry({ old: dying, meter: fromChain(400_000n), nowSec: T0 + 3600 })
    assertCarryKind(plan)
    expect(plan.boundary).toBe(T0 + DAY)
    // The carry cannot outlive the grant it replaces.
    expect(plan.carry?.expiresAt).toBe(T0 + DAY - 3600)
    // And there is no period after this one to resume into.
    expect(plan.steady).toBeNull()
  })
})
