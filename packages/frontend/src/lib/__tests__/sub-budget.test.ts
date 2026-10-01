import { describe, expect, it } from 'vitest'
import {
  expiryDateToUnixSeconds,
  parseSubBudgetAmount,
  subBudgetRefusalCopy,
  unixSecondsToDateInput,
  endDateIsClamped,
  formatSubBudgetDate,
} from '../sub-budget'

describe('parseSubBudgetAmount (#3506)', () => {
  it('converts human decimals to atomic with exact math', () => {
    expect(parseSubBudgetAmount('1.5', 6)).toEqual({ ok: true, atomic: '1500000' })
    expect(parseSubBudgetAmount('25', 6)).toEqual({ ok: true, atomic: '25000000' })
    expect(parseSubBudgetAmount('0.000001', 6)).toEqual({ ok: true, atomic: '1' })
    // A float would round this; the string math must not.
    expect(parseSubBudgetAmount('9007199254740993.123456', 6)).toEqual({
      ok: true,
      atomic: '9007199254740993123456',
    })
  })

  it('rejects more than 6 decimals', () => {
    expect(parseSubBudgetAmount('1.0000001', 6)).toEqual({ ok: false, reason: 'too_many_decimals' })
  })

  it('rejects zero, negative, empty and malformed input', () => {
    expect(parseSubBudgetAmount('0', 6)).toEqual({ ok: false, reason: 'not_positive' })
    expect(parseSubBudgetAmount('0.000000', 6)).toEqual({ ok: false, reason: 'not_positive' })
    expect(parseSubBudgetAmount('-5', 6)).toEqual({ ok: false, reason: 'not_positive' })
    expect(parseSubBudgetAmount('', 6)).toEqual({ ok: false, reason: 'empty' })
    expect(parseSubBudgetAmount('abc', 6)).toEqual({ ok: false, reason: 'invalid' })
    expect(parseSubBudgetAmount('1e3', 6)).toEqual({ ok: false, reason: 'invalid' })
    expect(parseSubBudgetAmount('.', 6)).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('expiryDateToUnixSeconds (#3506)', () => {
  const now = Date.UTC(2026, 9, 1) / 1000
  it('is the end of the chosen day, in unix seconds', () => {
    expect(expiryDateToUnixSeconds('2026-10-05', now)).toBe(Date.UTC(2026, 9, 5, 23, 59, 59) / 1000)
  })
  it('clamps to the parent expiry and rejects the past', () => {
    const parent = Date.UTC(2026, 9, 5, 12) / 1000
    expect(expiryDateToUnixSeconds('2026-10-05', now, parent)).toBe(parent)
    expect(expiryDateToUnixSeconds('2026-09-01', now)).toBeNull()
    expect(expiryDateToUnixSeconds('nope', now)).toBeNull()
  })
  it('round-trips the date input format', () => {
    expect(unixSecondsToDateInput(Date.UTC(2026, 9, 5, 23, 59, 59) / 1000)).toBe('2026-10-05')
  })
})

describe('subBudgetRefusalCopy (#3506)', () => {
  const copy = (error_code?: string, reason?: string, status = 400) =>
    subBudgetRefusalCopy({ status, body: { error_code, reason } }, 'Atlas', 'Scout')

  it('maps every refusal to plain words', () => {
    expect(copy('sub_budget_wider_than_parent', 'amount')).toBe(
      "This is more than Atlas's own budget allows per period. Lower the amount.",
    )
    expect(copy('sub_budget_wider_than_parent', 'expiry')).toMatch(/last longer than Atlas's own budget/)
    expect(copy('sub_budget_wider_than_parent', 'recipient')).toMatch(/one specific recipient/)
    expect(copy('parent_not_period_scoped')).toMatch(/more than one token/)
    expect(copy('sub_budget_exceeds_remaining', undefined, 409)).toMatch(/already shared most of this budget/)
    expect(copy('no_delegation_for_target', undefined, 403)).toMatch(/no active budget/)
    expect(copy('not_delegation_rail', undefined, 409)).toMatch(/Scout isn't ready/)
    expect(subBudgetRefusalCopy({ status: 404, body: {} }, 'Atlas', 'Scout')).toMatch(/could not find Scout/)
  })

  it('never leaks codes or engineering words', () => {
    for (const [c, r] of [
      ['sub_budget_wider_than_parent', 'amount'],
      ['sub_budget_wider_than_parent', 'expiry'],
      ['sub_budget_wider_than_parent', 'recipient'],
      ['parent_not_period_scoped', undefined],
      ['sub_budget_exceeds_remaining', undefined],
      ['no_delegation_for_target', undefined],
      ['not_delegation_rail', undefined],
      [undefined, undefined],
    ] as const) {
      expect(copy(c, r)).not.toMatch(/delegat|caveat|_|\bcode\b/i)
    }
  })
})

describe('end-date clamp disclosure (#3506 design review)', () => {
  // 2027-06-02T23:59:59Z — a parent budget's end.
  const parentEnd = Date.UTC(2027, 5, 2, 23, 59, 59) / 1000

  it('flags a date past the parent end, which expiryDateToUnixSeconds pulls back', () => {
    expect(endDateIsClamped('2027-07-01', parentEnd)).toBe(true)
    expect(expiryDateToUnixSeconds('2027-07-01', 0, parentEnd)).toBe(parentEnd)
  })

  it('does not flag the parent end day itself, an earlier date, or a malformed one', () => {
    expect(endDateIsClamped('2027-06-02', parentEnd)).toBe(false)
    expect(endDateIsClamped('2027-01-15', parentEnd)).toBe(false)
    expect(endDateIsClamped('', parentEnd)).toBe(false)
    expect(endDateIsClamped('nope', parentEnd)).toBe(false)
  })

  it('formats a date for people, in UTC, the same in every timezone', () => {
    expect(formatSubBudgetDate(parentEnd)).toBe('2 Jun 2027')
  })
})
