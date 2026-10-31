import { describe, expect, it } from 'vitest'
import { formatClockTime } from '../format'

/**
 * `formatClockTime` (#4572): the ONE clock-time rule for a row that sits under
 * a `TransactionActivityDayHeader` band. en-GB, 24-hour, `HH:MM` — the band
 * already states the day, so the row states the time of day and nothing else.
 *
 * The instants are written with an explicit offset and the assertions read the
 * LOCAL clock, because that is what the helper renders: a ledger row's time is
 * the user's wall clock, not UTC. The test pins the zone it asserts in so it
 * cannot pass in one CI zone and fail in another.
 */
describe('formatClockTime (#4572)', () => {
  it('renders an afternoon instant as 24-hour HH:MM', () => {
    // 14:05 local, whatever the runner's zone: build the instant from local
    // parts so the assertion is about the FORMAT, not about the zone.
    const local = new Date(2026, 9, 20, 14, 5, 0)
    expect(formatClockTime(local)).toBe('14:05')
  })

  it('renders midnight as 00:MM, never 24:MM or 12:MM AM', () => {
    expect(formatClockTime(new Date(2026, 9, 20, 0, 5, 0))).toBe('00:05')
  })

  it('renders a single-digit hour zero-padded', () => {
    expect(formatClockTime(new Date(2026, 9, 20, 9, 7, 0))).toBe('09:07')
  })

  it('accepts an ISO string, a Date and epoch milliseconds alike', () => {
    const date = new Date(2026, 9, 20, 14, 5, 0)
    expect(formatClockTime(date.toISOString())).toBe('14:05')
    expect(formatClockTime(date)).toBe('14:05')
    expect(formatClockTime(date.getTime())).toBe('14:05')
  })

  it('never renders a relative phrase — the band owns the day', () => {
    const old = new Date(Date.now() - 29 * 24 * 3_600_000)
    expect(formatClockTime(old)).toMatch(/^\d{2}:\d{2}$/)
    expect(formatClockTime(old)).not.toMatch(/ago/)
  })
})
