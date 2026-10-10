/**
 * Pinned-clock regression tests for the #3824 follow-up: the dashboard
 * activity window must cover the SEVEN user-local calendar days ending at
 * `now` — including the transition day, on the morning after a 23h
 * spring-forward day.
 *
 * The bug this pins: `activityWindowDays` used to sample fixed 24h offsets
 * (`now - i * 86_400`) and take each sample's local day. Local days are
 * 23/24/25h long, so on the morning after a 23h spring-forward day the
 * samples landed twice in one day and never in the transition day — and
 * `buildActivityGroups` (which drops every transaction whose local day is
 * not in the window) silently lost that day's real payments from the
 * dashboard for roughly the first hour of the morning. Once a year,
 * production-only, invisible to every test that runs at a normal clock.
 *
 * The expected windows below are HARDCODED (independently derived calendar
 * arithmetic — python zoneinfo cross-checked), not computed with the code
 * under test: an expectation that shares the implementation's walk cannot
 * fail when the walk is wrong.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../infra/prices.js', () => ({
  getTokenPrice: async () => ({ usd: 1, eur: 0.9, sek: 10.76 }),
}))

import {
  ACTIVITY_WINDOW_DAYS,
  activityWindowDays,
  buildActivityGroups,
  localDayKey,
} from '../activity.js'
import type { EnrichedTransaction } from '../types.js'

let seq = 0

function row(
  overrides: Omit<Partial<EnrichedTransaction>, 'timestamp'> & { timestamp: number },
): EnrichedTransaction {
  return {
    hash: `0x${String(++seq).padStart(4, '0').repeat(16)}`,
    type: 'erc20',
    from: '0x' + 'ab'.repeat(20),
    to: '0x' + 'ee'.repeat(20),
    value: '1000000',
    valueFormatted: '1.0',
    asset: 'USDC',
    tokenSymbol: 'USDC',
    tokenAddress: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    decimals: 6,
    direction: 'out',
    timestampSource: 'confirmed_at',
    blockNumber: null,
    isError: false,
    chainId: 84532,
    accountId: 'acc-window',
    accountAddress: '0x' + 'cd'.repeat(20),
    accountName: 'Window account',
    ...overrides,
  }
}

/**
 * The seven consecutive `YYYY-MM-DD` keys ending at `endingOn` — the shape
 * every window must have, spelled out day by day.
 */
function sevenDaysEndingAt(endingOn: string): string[] {
  const days: string[] = []
  for (let i = 0; i < ACTIVITY_WINDOW_DAYS; i += 1) {
    days.push(
      new Date(Date.parse(`${endingOn}T00:00:00Z`) - i * 86_400_000)
        .toISOString()
        .slice(0, 10),
    )
  }
  return days
}

describe('activityWindowDays — pinned clocks', () => {
  /**
   * Each case: (zone, pinned `now`, the local wall clock that instant
   * represents, the local day whose payments the old fixed-offset sampling
   * lost). Every `now` sits in the first hour of the morning AFTER a
   * spring-forward transition — the exact production window of the bug.
   */
  const pinned = [
    {
      tz: 'Europe/Stockholm',
      now: Date.parse('2026-03-29T22:20:00Z'), // 00:20 CEST Mon Mar 30
      wall: '2026-03-30 00:20 CEST',
      transitionDay: '2026-03-29', // 23h day (02:00 → 03:00)
    },
    {
      tz: 'America/New_York',
      now: Date.parse('2026-03-09T04:20:00Z'), // 00:20 EDT Mon Mar 9
      wall: '2026-03-09 00:20 EDT',
      transitionDay: '2026-03-08', // 23h day (02:00 → 03:00)
    },
    {
      tz: 'Australia/Lord_Howe',
      now: Date.parse('2026-10-04T13:20:00Z'), // 00:20 +11:00 Mon Oct 5
      wall: '2026-10-05 00:20 +11:00',
      transitionDay: '2026-10-04', // 30-minute shift (02:00 → 02:30)
    },
    {
      tz: 'Pacific/Chatham',
      now: Date.parse('2026-09-27T10:35:00Z'), // 00:20 +13:45 Mon Sep 28
      wall: '2026-09-28 00:20 +13:45',
      transitionDay: '2026-09-27', // 45-minute offset zone
    },
  ]

  for (const { tz, now, wall, transitionDay } of pinned) {
    it(`covers the transition day at ${tz} ${wall}`, () => {
      const window = activityWindowDays(now, tz)

      // The window is exactly the seven local calendar days ending at now —
      // the transition day included. Under the old fixed-offset sampling the
      // transition day is absent from this exact clock (the samples step
      // 24h apart across a 23h day and jump clean over it).
      expect([...window].sort()).toEqual(
        sevenDaysEndingAt(localDayKey(Math.floor(now / 1000), tz)).sort(),
      )
      expect(window.has(transitionDay)).toBe(true)
      expect(window.size).toBe(ACTIVITY_WINDOW_DAYS)
    })
  }

  it('survives the morning after a 25h fall-back day too (Europe/Stockholm 2026-10-26 00:20 CET)', () => {
    // The negative control: after a 25h day the OLD sampling happened to
    // stay correct (it duplicated a day rather than skipping one). The new
    // walk must produce the same seven-day window there, not just fix the
    // spring-forward side.
    const now = Date.parse('2026-10-25T23:20:00Z') // 00:20 CET Mon Oct 26
    const window = activityWindowDays(now, 'Europe/Stockholm')
    expect([...window].sort()).toEqual(sevenDaysEndingAt('2026-10-26').sort())
    expect(window.has('2026-10-25')).toBe(true) // the 25h transition day
  })

  it('keeps the seven window days consecutive for every hour of the 2026 DST transition months', () => {
    // The sweep property the pinned clocks generalize: at EVERY instant the
    // window is exactly seven consecutive local calendar days ending at
    // now's own local day. The old sampling breaks the consecutiveness on
    // spring-forward mornings (a two-day gap where the transition day was
    // skipped); this assertion is what fails there.
    const zones = [
      'Europe/Stockholm',
      'Europe/London',
      'America/New_York',
      'America/Santiago',
      'Asia/Beirut',
      'Africa/Casablanca',
      'Australia/Lord_Howe',
      'Pacific/Chatham',
      'Antarctica/Troll',
      'UTC',
    ]
    let instants = 0
    for (const tz of zones) {
      for (const monthStart of ['2026-03-01T00:00:00Z', '2026-10-01T00:00:00Z']) {
        for (let ms = Date.parse(monthStart); ms < Date.parse(monthStart) + 31 * 86_400_000; ms += 3_600_000) {
          instants += 1
          const window = activityWindowDays(ms, tz)
          const sorted = [...window].sort()
          expect(sorted, `${tz} @ ${new Date(ms).toISOString()}`).toHaveLength(
            ACTIVITY_WINDOW_DAYS,
          )
          for (let i = 1; i < sorted.length; i += 1) {
            const gap =
              Date.parse(`${sorted[i]}T00:00:00Z`) -
              Date.parse(`${sorted[i - 1]}T00:00:00Z`)
            expect(gap, `${tz} @ ${new Date(ms).toISOString()}`).toBe(86_400_000)
          }
          // The newest window day is now's own local day, and now's day is
          // in the window (buildActivityGroups relies on both).
          const today = localDayKey(Math.floor(ms / 1000), tz)
          expect(sorted[sorted.length - 1], `${tz} @ ${new Date(ms).toISOString()}`).toBe(today)
          expect(window.has(today), `${tz} @ ${new Date(ms).toISOString()}`).toBe(true)
        }
      }
    }
    // Guard the sweep itself: it must have actually run over the transition
    // mornings, not been silently emptied by a bad range.
    expect(instants).toBeGreaterThan(10 * 30 * 24)
  }, 60_000)
})

describe('buildActivityGroups — pinned spring-forward clock', () => {
  it('keeps the transition day’s payments groupable on the morning after a 23h day', async () => {
    // Europe/Stockholm, 2026-03-30 00:20 CEST — the production bug window.
    // One payment yesterday afternoon (the 23h transition day, 2026-03-29),
    // one right now. Both must group. Under the old fixed-offset window the
    // transition day was not in the set, so `buildActivityGroups` dropped
    // every transition-day row and this returns ONE group, not two.
    const now = Date.parse('2026-03-29T22:20:00Z')
    const transactions = [
      row({ timestamp: Math.floor(Date.parse('2026-03-29T12:00:00Z') / 1000) }), // 14:00 CEST on the transition day
      row({ timestamp: Math.floor(now / 1000) }), // 00:20 CEST, the morning after
    ]

    const groups = await buildActivityGroups({
      transactions,
      truncated: false,
      tz: 'Europe/Stockholm',
      now,
    })

    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.count)).toEqual([1, 1])
    // Newest first: the morning-after group leads, the transition day's
    // payment is still present behind it (not dropped from the window).
    expect(groups[0].latestAt).toBe(new Date(now).toISOString())
    expect(new Date(groups[1].latestAt).toISOString()).toBe('2026-03-29T12:00:00.000Z')
  })
})
