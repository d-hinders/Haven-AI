import { describe, expect, it } from 'vitest'
import { currentPeriodBounds } from './period-bounds.js'

/**
 * Pins for the shared boundary arithmetic (#3806). The frontend's property
 * test (`lib/__tests__/budget-caption.test.ts`) drives the same function
 * through the caption helper over random inputs; these are the deterministic
 * edges, kept next to the definition.
 */
describe('currentPeriodBounds', () => {
  it('anchors on start_date, floored to whole periods', () => {
    // The #3806 anchor: start 2026-10-08T12:02:00Z, daily period, now
    // 2026-10-09T09:00:00Z — under one period elapsed, so the current period
    // ends 2026-10-09T12:02:00Z.
    expect(currentPeriodBounds(1_791_460_920, 86_400, 1_791_536_400)).toEqual({
      start: 1_791_460_920,
      end: 1_791_547_320,
    })
  })

  it('rolls forward whole periods from start_date, never from the wall clock', () => {
    // One hour past that boundary: one period has elapsed, and the phase
    // stays 12:02Z — 2026-10-10T12:02:00Z.
    expect(currentPeriodBounds(1_791_460_920, 86_400, 1_791_550_920)).toEqual({
      start: 1_791_547_320,
      end: 1_791_633_720,
    })
  })

  it('a now before start_date yields the first period unchanged', () => {
    // The dormant half of a re-key: the steady grant's period has not begun.
    expect(currentPeriodBounds(1_800_000_000, 3_600, 1_799_999_999)).toEqual({
      start: 1_800_000_000,
      end: 1_800_003_600,
    })
  })

  it('a non-positive period is inert — start bounds start + period', () => {
    expect(currentPeriodBounds(100, 0, 1_000_000)).toEqual({ start: 100, end: 100 })
  })
})
