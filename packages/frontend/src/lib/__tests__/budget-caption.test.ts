import { describe, expect, it } from 'vitest'
import { currentPeriodBounds } from '@haven_ai/core'
import {
  budgetCaption,
  budgetNoteLine,
  budgetPeriodWords,
  budgetReservedNote,
  formatNextEvent,
  nextRefillAt,
  selectPrimaryBudgets,
  type BudgetCaptionRow,
} from '../budget-caption'

// The #3806 anchor: a period runs from start_date. start 2026-10-08T12:02:00Z,
// daily, read at 2026-10-09T09:00:00Z → the current period ends 12:02:00Z.
const ANCHOR_START = 1_791_460_920
const ANCHOR_NOW = Date.parse('2026-10-09T09:00:00Z')

function row(overrides: Partial<BudgetCaptionRow> = {}): BudgetCaptionRow {
  return {
    token: 'USDC',
    recipient: null,
    startSec: ANCHOR_START,
    periodSeconds: 86_400,
    expiresSec: null,
    budgetAtomic: '5000000',
    usedAtomic: '1250000',
    readFromChain: true,
    periodEndMs: null,
    symbol: 'USDC',
    chainId: 8453,
    ...overrides,
  }
}

describe('the anchor (#3806)', () => {
  it('start 2026-10-08T12:02Z + 1 day, read 2026-10-09T09:00Z → next refill 2026-10-09T12:02Z', () => {
    expect(nextRefillAt(ANCHOR_START, 86_400, ANCHOR_NOW)).toBe(Date.parse('2026-10-09T12:02:00Z'))
  })

  it('the next refill is the shared currentPeriodBounds end — one definition, both sides', () => {
    expect(nextRefillAt(ANCHOR_START, 86_400, ANCHOR_NOW)).toBe(
      currentPeriodBounds(ANCHOR_START, 86_400, Math.floor(ANCHOR_NOW / 1000)).end * 1000,
    )
  })

  it('rendered in a named zone it reads 14:02 — and 13:02 across the 2026-10-25 DST change', () => {
    // Three days before the refill the weekday branch renders the time of day:
    // 12:02Z is 14:02 in Stockholm while CEST (UTC+2) holds…
    const before = Date.parse('2026-10-06T09:00:00Z')
    expect(formatNextEvent(nextRefillAt(ANCHOR_START, 86_400, before), before, 'Europe/Stockholm')).toBe('Fri 14:02')
    // …and 13:02 once CET (UTC+1) begins on 2026-10-25. The boundary keeps its
    // UTC phase; the zone's rendering moves under it.
    const afterStart = 1_793_016_120 // 2026-10-26T12:02:00Z
    const afterNow = Date.parse('2026-10-24T09:00:00Z')
    expect(formatNextEvent(nextRefillAt(afterStart, 86_400, afterNow), afterNow, 'Europe/Stockholm')).toBe('Tue 13:02')
  })
})

describe('the next-refill property', () => {
  // Deterministic PRNG so a failure is reproducible from this file alone.
  let seed = 0x3806
  const rand = (n: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed % n
  }

  it('next refill = currentPeriodBounds(start, P, floor(now/1000)).end, over random start, P ≥ 60, read time and lag up to 3P', () => {
    for (let i = 0; i < 500; i++) {
      const periodSeconds = 60 + rand(3_000_000)
      // The read's own period_end may lag the true boundary by up to 3P: the
      // anchor still decides, and the refill never lands at or before now.
      const startSec = 1_700_000_000 + rand(50_000_000)
      const boundarySec = currentPeriodBounds(startSec, periodSeconds, 1_900_000_000).end
      const lagSec = rand(periodSeconds * 3)
      const nowMs = (boundarySec - lagSec) * 1000 + rand(1_000)
      const refill = nextRefillAt(startSec, periodSeconds, nowMs)
      expect(refill).toBe(currentPeriodBounds(startSec, periodSeconds, Math.floor(nowMs / 1000)).end * 1000)
      expect(refill).toBeGreaterThan(nowMs)
    }
  })

  it('includes now = boundary + {−1000, −1, 0, +1, +999} ms — the ceil((now−end)/P) mutant dies at +0', () => {
    // start 12:02:00Z, daily: the boundary after the anchor now is 12:02:00Z
    // on 10-09. A mutant that rolls with ceil((now−end)/P) instead of the
    // anchor's floor returns the boundary ITSELF when now lands exactly on
    // it — a refill in the past.
    const boundaryMs = 1_791_547_320_000 // 2026-10-09T12:02:00Z
    for (const delta of [-1_000, -1, 0, 1, 999]) {
      const nowMs = boundaryMs + delta
      expect(nextRefillAt(ANCHOR_START, 86_400, nowMs)).toBe(
        currentPeriodBounds(ANCHOR_START, 86_400, Math.floor(nowMs / 1000)).end * 1000,
      )
      expect(nextRefillAt(ANCHOR_START, 86_400, nowMs)).toBeGreaterThan(nowMs)
    }
  })
})

describe('period words (owner decision 2)', () => {
  it('the named rhythms', () => {
    expect(budgetPeriodWords(86_400)).toBe('per day')
    expect(budgetPeriodWords(604_800)).toBe('per week')
    expect(budgetPeriodWords(2_592_000)).toBe('per month')
    expect(budgetPeriodWords(3_600)).toBe('per hour')
  })

  it('anything else: the largest unit that divides it exactly', () => {
    expect(budgetPeriodWords(60)).toBe('every 1 minute')
    expect(budgetPeriodWords(90)).toBe('every 90 seconds')
    expect(budgetPeriodWords(5_400)).toBe('every 90 minutes')
    expect(budgetPeriodWords(14_400)).toBe('every 4 hours')
    expect(budgetPeriodWords(86_401)).toBe('every 86401 seconds')
    expect(budgetPeriodWords(1_209_600)).toBe('every 14 days')
    expect(budgetPeriodWords(31_536_000)).toBe('every 365 days')
  })
})

describe('next-event phrasing', () => {
  const now = Date.parse('2026-10-09T09:00:00Z')
  it('under 24 h: relative', () => {
    expect(formatNextEvent(now + 45 * 60_000, now, 'UTC')).toBe('in 45m')
    expect(formatNextEvent(now + 5 * 3_600_000, now, 'UTC')).toBe('in 5h')
  })

  it('under 7 days: weekday and 24-hour time, in the explicit zone', () => {
    expect(formatNextEvent(Date.parse('2026-10-14T14:02:00Z'), now, 'UTC')).toBe('Wed 14:02')
  })

  it('otherwise: day and month', () => {
    expect(formatNextEvent(Date.parse('2026-11-14T00:00:00Z'), now, 'UTC')).toBe('14 Nov')
  })
})

describe('states', () => {
  it('meter: used of cap, two decimals, with the next event', () => {
    const caption = budgetCaption(row(), { nowMs: ANCHOR_NOW, timeZone: 'UTC' })
    expect(caption).toEqual({
      kind: 'meter',
      usedPercent: 25,
      label: 'USDC budget used',
      caption: '1.25 of 5.00 USDC used this period · refills in 3h',
    })
  })

  it('expired: no meter, no countdown', () => {
    const caption = budgetCaption(row({ expiresSec: Math.floor(ANCHOR_NOW / 1000) - 60 }), { nowMs: ANCHOR_NOW })
    expect(caption).toEqual({ kind: 'expired', caption: 'This budget has expired and can no longer be spent.' })
  })

  it('not-started: a future start_date — the dormant half of a re-key', () => {
    const caption = budgetCaption(row({ startSec: Math.floor(ANCHOR_NOW / 1000) + 3 * 86_400 }), {
      nowMs: ANCHOR_NOW,
      timeZone: 'UTC',
    })
    expect(caption).toEqual({ kind: 'not-started', caption: 'Starts Mon 09:00' })
  })

  it('unknown: the chain read failed — no meter, never "0 used", never "snapshot"', () => {
    const caption = budgetCaption(row({ usedAtomic: '5000000', readFromChain: false }), { nowMs: ANCHOR_NOW })
    expect(caption.kind).toBe('unknown')
    if (caption.kind !== 'unknown') return
    expect(caption.caption).toMatch(/couldn.t be read/)
    expect(caption.caption).not.toMatch(/snapshot/)
  })

  it('refilled-updating: now ≥ the read period_end — the old amount is never paired with the next refill', () => {
    // The read's boundary passed two hours ago; the used amount belongs to a
    // FINISHED period, so it shows as unknown until the next read.
    const caption = budgetCaption(row({ periodEndMs: ANCHOR_NOW - 2 * 3_600_000 }), { nowMs: ANCHOR_NOW })
    expect(caption.kind).toBe('refilled-updating')
    if (caption.kind !== 'refilled-updating') return
    expect(caption.caption).toMatch(/couldn.t be read/)
    expect(caption.caption).not.toMatch(/refills|used this period/)
  })

  it('none: no figure on the row renders nothing, not zero', () => {
    expect(budgetCaption(row({ usedAtomic: null }), { nowMs: ANCHOR_NOW })).toEqual({ kind: 'none' })
  })

  it('"does not refill" is never keyed on a period length — the earlier of refill and expiry wins', () => {
    // A re-key carry row: expires AT its period boundary, so it reads as an
    // expiry — while a shorter-lived budget with room after it still refills.
    const carry = budgetCaption(row({ expiresSec: Math.floor(ANCHOR_NOW / 1000) + 3 * 3_600 }), {
      nowMs: ANCHOR_NOW,
      timeZone: 'UTC',
    })
    expect(carry).toEqual({
      kind: 'meter',
      usedPercent: 25,
      label: 'USDC budget used',
      // 2026-10-09T12:00Z is at the boundary — expiry ties the refill — and
      // 3h out it reads relative, like any next event under a day.
      caption: '1.25 of 5.00 USDC used this period · expires in 3h',
    })
  })

  it('currency mode: one leading ≈, the caller’s rate; an unknown rate falls back to token mode', () => {
    const caption = budgetCaption(row(), { nowMs: ANCHOR_NOW, timeZone: 'UTC', rate: { currency: 'USD', perToken: 1 } })
    expect(caption.kind).toBe('meter')
    if (caption.kind !== 'meter') return
    expect(caption.caption).toBe('≈$1.25 of $5.00 used this period · refills in 3h')
    expect(caption.caption.match(/≈/g)).toHaveLength(1)
  })
})

describe('notes', () => {
  const opts = { chainId: 8453 as number | null }
  it('incl. … by Helper, in the caption mode', () => {
    expect(budgetNoteLine({ agentName: 'Helper', usedAtomic: '1250000' }, 'USDC', opts)).toBe('incl. 1.25 USDC by Helper')
    expect(budgetNoteLine({ agentName: 'Helper', usedAtomic: '1250000' }, 'USDC', { ...opts, rate: { currency: 'SEK', perToken: 10 } })).toBe(
      // sv-SE styles the suffix with an NBSP before "kr".
      'incl. ≈12,50\u00A0kr by Helper',
    )
  })

  it('the reserved-for-task-budgets line', () => {
    expect(budgetReservedNote('1000000', 'USDC', opts)).toBe('1.00 USDC reserved for task budgets')
  })
})

describe('several budgets (the dashboard row)', () => {
  const now = ANCHOR_NOW
  const nowSec = Math.floor(now / 1000)
  it('a carry/steady pair in one slot counts as one', () => {
    // The carry lives until its boundary; the steady grant starts exactly
    // there (future) — so exactly one row is live and the pair is one budget.
    const carry = row({ token: 'USDC', recipient: null, expiresSec: nowSec + 3_600 })
    const steady = row({ token: 'USDC', recipient: null, startSec: nowSec + 3_600 })
    const selected = selectPrimaryBudgets([carry, steady], now)
    expect(selected).not.toBeNull()
    expect(selected!.extraCount).toBe(0)
    expect(selected!.primary).toBe(carry)
  })

  it('a future-start row on its own is excluded from the count', () => {
    const live = row({})
    const dormant = row({ token: 'USDC', recipient: null, startSec: nowSec + 86_400 })
    const selected = selectPrimaryBudgets([live, dormant], now)
    expect(selected!.extraCount).toBe(0)
    expect(selected!.primary).toBe(live)
  })

  it('expired rows are excluded from the count (#3802)', () => {
    const live = row({})
    const dead = row({ token: 'USDC', recipient: null, expiresSec: nowSec - 60 })
    const selected = selectPrimaryBudgets([live, dead], now)
    expect(selected!.extraCount).toBe(0)
    expect(selected!.primary).toBe(live)
  })

  it('primary: the highest used % among rows with a read, ties by the soonest refill', () => {
    const low = row({ token: 'USDC', recipient: '0x' + 'aa'.repeat(20), usedAtomic: '500000' }) // 10%
    const high = row({ token: 'USDC', recipient: '0x' + 'bb'.repeat(20), usedAtomic: '2500000' }) // 50%
    const tie = row({ token: 'USDC', recipient: '0x' + 'cc'.repeat(20), usedAtomic: '1250000', periodSeconds: 3_600 }) // 25%, sooner refill
    const selected = selectPrimaryBudgets([low, high, tie], now)
    expect(selected!.primary).toBe(high)
    expect(selected!.extraCount).toBe(2)
    // 25% vs 25%: the hourly tie refills sooner than the daily row.
    const tieLow = row({ token: 'USDC', recipient: '0x' + 'dd'.repeat(20), usedAtomic: '1250000' })
    const tieSoon = row({ token: 'USDC', recipient: '0x' + 'ee'.repeat(20), usedAtomic: '1250000', periodSeconds: 3_600 })
    expect(selectPrimaryBudgets([tieLow, tieSoon], now)!.primary).toBe(tieSoon)
  })

  it('no row has a read: the first by created_at, used unknown', () => {
    const second = row({ token: 'USDC', recipient: '0x' + 'aa'.repeat(20), usedAtomic: null, createdMs: ANCHOR_NOW - 1_000 })
    const first = row({ token: 'USDC', recipient: '0x' + 'bb'.repeat(20), usedAtomic: null, createdMs: ANCHOR_NOW - 60_000 })
    const selected = selectPrimaryBudgets([second, first], now)
    expect(selected!.primary).toBe(first)
    expect(budgetCaption(selected!.primary, { nowMs: now }).kind).toBe('none')
  })

  it('nothing live: no primary at all', () => {
    expect(selectPrimaryBudgets([], now)).toBeNull()
    expect(selectPrimaryBudgets([row({ startSec: nowSec + 86_400 })], now)).toBeNull()
  })
})
