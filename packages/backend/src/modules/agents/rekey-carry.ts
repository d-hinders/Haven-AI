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
 * ## Two clocks, and why conflating them under-granted (#1849)
 *
 * The remainder is measured at REVOKE/METER time and the delegations are built
 * at ISSUE time, and nothing bounds the gap between them — an owner can start a
 * re-key, be interrupted, and finish it later. Those are two different
 * instants, and they answer two different questions:
 *
 * - **`meteredAtSec`** — the period the remainder was measured in. The
 *   remainder is only meaningful inside that period, so ALL the arithmetic
 *   here is anchored to it.
 * - **`nowSec`** — the present. Used for exactly one thing: dropping a piece
 *   the delay has already outrun, so the owner is never asked to sign a grant
 *   that is dead on arrival.
 *
 * Before #1849 there was one clock, the issue-time one, and the remainder was
 * therefore spent against whichever period the owner happened to finish in. It
 * could not over-grant — the cap is the remainder either way — but it silently
 * UNDER-granted, and at its worst gave an agent nothing at all for a period it
 * was owed a full budget in. The composition below is correct at every gap
 * size without a timeout anyone has to pick a number for: a gap inside the
 * period is byte-identical to before, and a gap across a boundary drops the
 * carry as expired and leaves the steady grant live on the ORIGINAL budget
 * from the true old boundary — exactly what the un-revoked delegation would
 * have done.
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
  | { kind: 'dormant'; reissue: DelegationTerms | null; dropped: DroppedPiece[] }
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
      /**
       * Pieces the delay outran between metering and issue (#1849). Dropped
       * rather than issued: `buildBudgetDelegation` has no "expiry must be in
       * the future" check, so a piece whose window has closed would be built,
       * persisted, and put in front of the owner to SIGN — a grant that can
       * never redeem.
       */
      dropped: DroppedPiece[]
    }

/** A grant the plan built and then discarded, with the reason to surface. */
export interface DroppedPiece {
  role: 'carry' | 'steady' | 'reanchor'
  reason: string
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
  /**
   * When the meter was read (`agent_rekeys.metered_at`) — the period the
   * remainder is meaningful in, and the anchor for every calculation below.
   */
  meteredAtSec: number
  /**
   * Now, at issue time. Used ONLY to drop a piece the delay has outrun; it
   * never influences which period the remainder belongs to (#1849).
   */
  nowSec: number
}): CarryPlan {
  const { old, meter, meteredAtSec, nowSec } = input
  assertTerms(old)
  if (!Number.isInteger(meteredAtSec) || !Number.isInteger(nowSec)) {
    throw new CarryRefusedError('metered_at and now must be whole seconds', 'invalid_terms')
  }
  if (nowSec < meteredAtSec) {
    // Issue cannot precede metering. The stage machine and migration 065's
    // `meter_after_revoke_check` already order the stages; a clock that says
    // otherwise is a bug or a skewed host, and carrying on would anchor the
    // arithmetic to a future the measurement never saw.
    throw new CarryRefusedError(
      'the meter was read after the current time — refusing to plan a carry against a clock ' +
        'that runs backwards',
      'invalid_terms',
    )
  }

  // ── The two cases that do not consult the meter AT ALL ─────────────────
  //
  // Decided FIRST, and the order is load-bearing rather than tidy. An expired
  // grant carries nothing; a grant whose first period has not opened cannot
  // have spent anything, so it is reissued verbatim. Neither reads
  // `meter`, so neither may be refused for what the meter says.
  //
  // Putting the meter refusals ahead of these wedged a real case, found while
  // re-checking the multi-delegation interaction after review: re-keying an
  // agent that was ALREADY re-keyed means re-keying its dormant "steady"
  // grant, and a period enforcer asked for the available amount of a
  // delegation whose first period has not started can revert — which
  // `readRemainingBudget` reports as `fromChain: false`. That fallback is
  // meaningless here and would have 409'd the entire second re-key on a
  // reading nothing was going to use.
  // Classified against the MEASUREMENT clock: these describe the state the
  // remainder was measured in, not the state at whatever time the owner got
  // round to finishing.
  if (meteredAtSec >= old.expiresAt) return { kind: 'expired' }
  if (meteredAtSec < old.startDate) {
    const reissue = { ...old }
    return live(reissue, nowSec)
      ? { kind: 'dormant', reissue, dropped: [] }
      : {
          kind: 'dormant',
          reissue: null,
          dropped: [{ role: 'reanchor', reason: expiredByDelay('re-anchored', old.expiresAt) }],
        }
  }

  // ── From here the meter IS the input, so it must be trustworthy ────────
  //
  // The refusal that keeps a transient RPC failure from becoming a fresh full
  // period. See the module header.
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

  const boundary = currentPeriodBoundary(old, meteredAtSec)

  // The carry lives inside the OLD period, so it is anchored one period
  // before the boundary — its current period IS the old one — and dies at
  // the boundary so it never refills.
  const carryExpiry = Math.min(boundary, old.expiresAt)
  const plannedCarry: DelegationTerms | null =
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
  const plannedSteady: DelegationTerms | null =
    old.expiresAt > boundary
      ? {
          budgetAtomic: old.budgetAtomic,
          periodSeconds: old.periodSeconds,
          startDate: boundary,
          expiresAt: old.expiresAt,
        }
      : null

  // ── Drop what the delay outran (#1849) ─────────────────────────────────
  //
  // The carry's whole window is the old period. If the owner finished after
  // that period ended, the carry is already over — and dropping it is not a
  // loss, because the steady grant below then starts in the PAST with the
  // full original budget, which is precisely what the un-revoked delegation
  // would have refilled to. The agent ends up correct rather than merely
  // warned.
  const dropped: DroppedPiece[] = []
  const carry = keep(plannedCarry, 'carry', nowSec, dropped)
  const steady = keep(plannedSteady, 'steady', nowSec, dropped)

  return { kind: 'carry', boundary, carry, steady, dropped }
}

/** A grant with a future expiry is still worth issuing; one without is not. */
function live(terms: DelegationTerms, nowSec: number): boolean {
  return terms.expiresAt > nowSec
}

function keep(
  terms: DelegationTerms | null,
  role: 'carry' | 'steady',
  nowSec: number,
  dropped: DroppedPiece[],
): DelegationTerms | null {
  if (!terms) return null
  if (live(terms, nowSec)) return terms
  dropped.push({ role, reason: expiredByDelay(role, terms.expiresAt) })
  return null
}

function expiredByDelay(role: string, expiresAt: number): string {
  return (
    `The ${role} grant's window closed at ${new Date(expiresAt * 1000).toISOString()}, before ` +
    'this re-key was finished. It is not issued: a grant that can never redeem is not worth a ' +
    "signature. If the agent needs authority in the current period, the replacement grant's own " +
    'schedule already covers it — otherwise re-grant its budget.'
  )
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
