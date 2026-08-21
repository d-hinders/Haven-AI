/**
 * The budget-meter carry for an agent re-key (#1698, epic #1694).
 *
 * Pure arithmetic, no I/O: given the OLD delegation's terms and the meter
 * read taken AFTER its revoke, produce the terms of the delegation(s) to
 * issue to the new delegate. Kept pure precisely because this is the part
 * that can leak budget, and a leak is provable by table rather than by
 * integration.
 *
 * ## The owner decision this implements
 *
 * > "The budget meter carries across a re-key: amount AND period boundary.
 * > The new delegation's first period is capped at the old remainder and ends
 * > when the old period would have. Carrying only the amount would let
 * > repeated re-keys shorten periods and leak budget." (#1694)
 *
 * The leak is worth spelling out, because the amount-only version looks
 * correct. Carry 40 of a 100 budget with a fresh period start, re-key again
 * an hour later carrying 40 again, and again: each re-key restarts the clock,
 * so an agent on a daily budget can be handed its remainder every hour. The
 * period is half the grant, and dropping it turns a rate limit into a tally.
 *
 * ## Why TWO delegations and not one
 *
 * The period enforcer takes exactly three numbers — `periodAmount`,
 * `periodDuration`, `startDate` — and refills to `periodAmount` at every
 * boundary. There is no "first period is smaller" in that shape. Expressing
 * the decision therefore takes two grants:
 *
 * - a **carry** grant: `periodAmount` = the frozen remainder, anchored so its
 *   current period is exactly the old one, and given a timestamp caveat that
 *   **expires at the boundary** so it can never refill into a second period;
 * - a **steady** grant: the original budget on the original cadence,
 *   `startDate` = the boundary, so it is dormant until the moment the carry
 *   dies and then runs on the schedule the owner originally granted.
 *
 * The two never overlap: the carry's expiry and the steady's start are the
 * same instant. Total spend inside the old period is capped at the remainder,
 * the boundary is preserved exactly, and every later period is the untouched
 * original grant.
 *
 * That composition is also what makes the bypass test pass. Re-key twice in
 * one period and the second read is of the CARRY grant, whose boundary is the
 * same instant as the first one's — so the third grant ends there too. No
 * number of re-keys inside a period can sum to more than the original budget.
 *
 * ## Refusing the fallback
 *
 * `readRemainingBudget` falls back to the FULL budget when the RPC read fails
 * — correct for a status display (see its header), and a budget leak here: a
 * failed read would hand a re-keying agent a fresh full period, which is the
 * exact outcome the boundary carry exists to prevent. This module refuses a
 * reading that did not come from the chain. Re-key is an owner-initiated,
 * retryable operation; waiting for a real read costs nothing.
 */

/** Matches the delegation-rail build route's floor. */
export const MIN_PERIOD_SECONDS = 60

/** The period enforcer's `periodAmount` is uint96. */
export const MAX_UINT96 = (1n << 96n) - 1n

/** The terms of one delegation, as `agent_delegations` stores them. */
export interface DelegationTerms {
  budgetAtomic: bigint
  periodSeconds: number
  /** Unix seconds — the period anchor. */
  startDate: number
  /** Unix seconds — the timestamp caveat's `beforeThreshold`. */
  expiresAt: number
}

/** What the enforcer said after the revoke froze it. */
export interface MeterReading {
  remainingAtomic: bigint
  /** False means the read FAILED and the amount is a fallback — never carry it. */
  fromChain: boolean
}

export type CarryPlan =
  /**
   * The old grant is already past its expiry. Nothing is carried, because
   * there is no live authority to carry: a fresh grant here would be the
   * owner granting a new budget, not a re-key preserving one.
   */
  | { kind: 'expired' }
  /**
   * The old grant's first period has not started yet, so nothing can have
   * been spent and there is nothing to freeze. Re-issue the identical terms
   * to the new delegate — a pure re-anchor, which preserves the boundary by
   * preserving the whole schedule.
   */
  | { kind: 'dormant'; reissue: DelegationTerms }
  /**
   * The live case. `boundary` is the instant the old period would have
   * refilled; `carry` covers up to it, `steady` resumes from it.
   *
   * `carry` is null when the remainder is zero — the agent genuinely has
   * nothing left this period, and a zero-amount grant is not buildable.
   * `steady` is null when the old grant would have expired at or before the
   * boundary, so there was never a period after this one to resume.
   */
  | {
      kind: 'carry'
      boundary: number
      carry: DelegationTerms | null
      steady: DelegationTerms | null
    }

/** Raised rather than returned: every one of these is a refusal, not a plan. */
export class CarryRefusedError extends Error {
  constructor(
    message: string,
    readonly code: 'meter_not_from_chain' | 'invalid_terms' | 'remainder_exceeds_budget',
  ) {
    super(message)
    this.name = 'CarryRefusedError'
  }
}

/**
 * The end of the period `nowSec` falls in, for a delegation anchored at
 * `startDate` with `periodSeconds` periods.
 *
 * Periods are half-open — `[startDate + n·p, startDate + (n+1)·p)` — matching
 * the enforcer, which refills when `block.timestamp` crosses a multiple of
 * `periodDuration` past `startDate`. Exactly ON a boundary the new period has
 * begun, so the boundary returned is the NEXT one.
 *
 * Only meaningful once the schedule has started; callers handle `nowSec <
 * startDate` as the dormant case rather than extrapolating backwards.
 */
export function currentPeriodBoundary(terms: DelegationTerms, nowSec: number): number {
  const elapsed = nowSec - terms.startDate
  const periodsElapsed = Math.floor(elapsed / terms.periodSeconds)
  return terms.startDate + (periodsElapsed + 1) * terms.periodSeconds
}

function assertTerms(terms: DelegationTerms): void {
  if (!Number.isInteger(terms.periodSeconds) || terms.periodSeconds < MIN_PERIOD_SECONDS) {
    throw new CarryRefusedError(
      `period_seconds must be an integer ≥ ${MIN_PERIOD_SECONDS}`,
      'invalid_terms',
    )
  }
  if (!Number.isInteger(terms.startDate) || !Number.isInteger(terms.expiresAt)) {
    throw new CarryRefusedError('start_date and expires_at must be whole seconds', 'invalid_terms')
  }
  if (terms.budgetAtomic <= 0n || terms.budgetAtomic > MAX_UINT96) {
    throw new CarryRefusedError('budget_atomic must be a positive uint96', 'invalid_terms')
  }
}

/**
 * Plan what to issue to the new delegate, from the old terms and the frozen
 * meter.
 *
 * `nowSec` is passed rather than read so the plan is a function of its inputs
 * — the boundary arithmetic is the thing under test, and a test that has to
 * mock the clock to reach it tests the mock.
 */
export function planCarry(input: {
  old: DelegationTerms
  meter: MeterReading
  nowSec: number
}): CarryPlan {
  const { old, meter, nowSec } = input
  assertTerms(old)

  // The refusal that keeps a transient RPC failure from becoming a fresh
  // full period. See the module header.
  if (!meter.fromChain) {
    throw new CarryRefusedError(
      'the remaining-budget read did not come from the chain — refusing to carry a fallback ' +
        'amount, which would hand the new key a full period. Retry the re-key.',
      'meter_not_from_chain',
    )
  }
  if (meter.remainingAtomic < 0n || meter.remainingAtomic > old.budgetAtomic) {
    // A remainder above the budget cannot be a remainder. Refuse rather than
    // clamp: clamping would silently issue the full budget on a bad read.
    throw new CarryRefusedError(
      'remaining budget exceeds the granted budget — refusing to carry an impossible reading',
      'remainder_exceeds_budget',
    )
  }

  if (nowSec >= old.expiresAt) return { kind: 'expired' }
  if (nowSec < old.startDate) return { kind: 'dormant', reissue: { ...old } }

  const boundary = currentPeriodBoundary(old, nowSec)

  // The carry lives inside the OLD period, so it is anchored one period
  // before the boundary — its current period IS the old one — and dies at
  // the boundary so it never refills.
  const carryExpiry = Math.min(boundary, old.expiresAt)
  const carry: DelegationTerms | null =
    meter.remainingAtomic > 0n
      ? {
          budgetAtomic: meter.remainingAtomic,
          periodSeconds: old.periodSeconds,
          startDate: boundary - old.periodSeconds,
          expiresAt: carryExpiry,
        }
      : null

  // The steady grant picks up exactly where the carry dies. If the old grant
  // would have expired at or before the boundary there is no period after
  // this one, so there is nothing to resume.
  const steady: DelegationTerms | null =
    old.expiresAt > boundary
      ? {
          budgetAtomic: old.budgetAtomic,
          periodSeconds: old.periodSeconds,
          startDate: boundary,
          expiresAt: old.expiresAt,
        }
      : null

  return { kind: 'carry', boundary, carry, steady }
}

/**
 * The total an agent may still spend before `boundary` under a plan — the
 * quantity the bypass test asserts cannot grow across repeated re-keys.
 */
export function spendableBeforeBoundary(plan: CarryPlan): bigint {
  if (plan.kind === 'expired') return 0n
  if (plan.kind === 'dormant') return 0n
  return plan.carry?.budgetAtomic ?? 0n
}
