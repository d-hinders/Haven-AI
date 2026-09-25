import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { timeAgo } from './format.js'

/**
 * The stale-hint clock (#3318). `timeAgo` words the `balanceFreshness`
 * `asOf` timestamp the same way the dashboard's indicator words it
 * (`packages/frontend/src/components/haven/BalanceFreshnessIndicator.tsx`,
 * the `as of 5m ago` beside a stale figure), so both surfaces render the one
 * wire marker with one vocabulary. The ladder is pinned against a FIXED
 * clock — a wall-clock-dependent formatter is one that passes at 09:00 and
 * fails at 09:01 — with the bucket edges spelled out, because 30-day months
 * and 365-day years make the seams land on surprising dates.
 */
describe('timeAgo (#3318 stale hint)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-25T18:45:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('walks the ladder the dashboard indicator renders, bucket edges included', () => {
    const vectors: [string, string][] = [
      // [asOf, rendered] — now is 2026-09-25T18:45:00Z throughout.
      ['2026-09-25T18:45:30.000Z', 'just now'], // read slightly in the future
      ['2026-09-25T18:44:59.000Z', 'just now'], // under a minute old
      ['2026-09-25T18:00:00.000Z', '45m ago'], // the issue's own example
      ['2026-09-25T07:46:00.000Z', '10h ago'], // 10h59m truncates to 10h
      ['2026-09-20T18:45:00.000Z', '5d ago'],
      ['2026-08-27T18:45:00.000Z', '29d ago'], // the last day that reads as days
      ['2026-08-26T18:45:00.000Z', '1mo ago'], // 30 days flips to months
      ['2026-07-27T18:45:00.000Z', '2mo ago'], // 60 days — not calendar months
      ['2024-09-25T18:45:00.000Z', '2y ago'], // 730 days — two 365-day years
    ]
    for (const [iso, want] of vectors) expect(timeAgo(iso)).toBe(want)
  })
})
