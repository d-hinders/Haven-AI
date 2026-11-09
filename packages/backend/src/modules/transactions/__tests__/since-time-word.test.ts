/**
 * The fixed "Since …" time word (#4709). Pure formatting, so no database and
 * no mocks — the set is closed and every branch is pinned exactly.
 */
import { describe, expect, it } from 'vitest'
import { sinceTimeWord } from '../activity.js'

describe('sinceTimeWord (#4709) — the fixed set, in the user’s timezone', () => {
  it('the same local day reads as "Since earlier today"', () => {
    expect(
      sinceTimeWord('2026-11-03T09:00:00.000Z', '2026-11-03T18:00:00.000Z', 'Europe/Stockholm'),
    ).toBe('Since earlier today')
  })

  it('the previous local day reads as "Since yesterday"', () => {
    expect(
      sinceTimeWord('2026-11-02T20:00:00.000Z', '2026-11-03T09:00:00.000Z', 'Europe/Stockholm'),
    ).toBe('Since yesterday')
  })

  it('within six days names the weekday', () => {
    // 2026-10-28 is a Wednesday; 2026-11-03 is a Tuesday — six days apart.
    expect(sinceTimeWord('2026-10-28T10:00:00.000Z', '2026-11-03T10:00:00.000Z', 'UTC')).toBe(
      'Since Wednesday',
    )
  })

  it('past six days names the date', () => {
    // Seven days: 2026-10-27 is a Tuesday, but the weekday is no longer used.
    expect(sinceTimeWord('2026-10-27T10:00:00.000Z', '2026-11-03T10:00:00.000Z', 'UTC')).toBe(
      'Since 27 October',
    )
  })

  it('speaks in the user’s zone, not UTC — the same instants can be "today" or "yesterday"', () => {
    const previous = '2026-11-02T23:30:00.000Z'
    const current = '2026-11-03T00:30:00.000Z'
    expect(sinceTimeWord(previous, current, 'UTC')).toBe('Since yesterday')
    // Stockholm is UTC+1 in November: both instants are on 3 November there.
    expect(sinceTimeWord(previous, current, 'Europe/Stockholm')).toBe('Since earlier today')
  })

  it('a previous instant after this one reads as "Since earlier today" — the window is empty', () => {
    expect(sinceTimeWord('2026-11-03T12:00:00.000Z', '2026-11-03T10:00:00.000Z', 'UTC')).toBe(
      'Since earlier today',
    )
  })
})
