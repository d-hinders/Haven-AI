import { describe, expect, it } from 'vitest'
import {
  BUDGET_END_DAYS,
  BUDGET_END_DEFAULT_DAYS,
  budgetEndDaysLabel,
  budgetEndsAt,
  formatBudgetEndDate,
} from '../budget-end'
import { unixSecondsToDateInput } from '../sub-budget'

// A fixed clock: 2026-10-23T14:00:00Z (the #4350 build date).
const NOW = Date.parse('2026-10-23T14:00:00Z') / 1000

describe('budget end presets (#4350, owner decision 1 on #4349)', () => {
  it('offers exactly 30/90/180/365 days, 90 the default — no "never"', () => {
    expect([...BUDGET_END_DAYS]).toEqual([30, 90, 180, 365])
    expect(BUDGET_END_DEFAULT_DAYS).toBe(90)
  })

  it('budgetEndsAt converts a preset to the END of that UTC day — the sub-budget conversion', () => {
    // 2026-10-23 + 90 days = 2027-01-21 → 2027-01-21T23:59:59Z.
    const ends = budgetEndsAt(90, NOW)
    expect(ends).toBe(Date.UTC(2027, 0, 21, 23, 59, 59) / 1000)
    // Every preset lands in the future from this clock.
    for (const days of BUDGET_END_DAYS) {
      expect(budgetEndsAt(days, NOW)).toBeGreaterThan(NOW)
    }
  })

  it('is monotonic in the preset and null never for a sane preset', () => {
    let last = NOW
    for (const days of BUDGET_END_DAYS) {
      const ends = budgetEndsAt(days, NOW)
      expect(ends).not.toBeNull()
      expect(ends!).toBeGreaterThan(last)
      last = ends!
    }
  })

  it('reuses the sub-budget date machinery exactly: the date input matches the conversion', () => {
    // The preset is dated (now + days), then converted end-of-UTC-day — the
    // SAME helper IssueSubBudgetModal uses, so the two pickers cannot drift.
    expect(budgetEndsAt(30, NOW)).toBe(
      (Date.UTC(2026, 10, 22, 23, 59, 59) / 1000), // 2026-11-22T23:59:59Z
    )
    expect(unixSecondsToDateInput(NOW + 30 * 86_400)).toBe('2026-11-22')
  })

  it('labels and dates are the sub-budget formatter', () => {
    expect(budgetEndDaysLabel(90)).toBe('90 days')
    expect(formatBudgetEndDate(Date.UTC(2027, 0, 21, 23, 59, 59) / 1000)).toBe('21 Jan 2027')
  })
})
