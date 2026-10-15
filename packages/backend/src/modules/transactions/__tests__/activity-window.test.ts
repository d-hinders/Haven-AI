/**
 * Pinned-clock regression tests for the dashboard Activity window — the
 * ROLLING `[now − 7×24h, now)` interval the owner decision fixed (epic
 * #3801, 2026-10-09: "Rolling 7 and 30 days; no calendar month"), the same
 * definition `spend.d7` and `/analytics/overview` use (#3975).
 *
 * History this file carries. #3824 originally windowed the card over the
 * seven user-local calendar days ending today, via a local-day walk —
 * `activityWindowDays(now, tz)` — whose once-a-year bug (fixed 24h-offset
 * sampling skipped the 23h spring-forward transition day) #3869 pinned here
 * with spring-forward clocks, a fall-back control and a 10-zone DST sweep.
 * #3975 moved membership to the rolling instant predicate
 * `isInsideActivityWindow`, which involves no zone arithmetic at all — so
 * the day-walk pins are gone and every one of them has an equivalent pin on
 * the new predicate: the boundary holds at every instant, the transition
 * day's payments still group on the mornings after spring-forward and
 * fall-back, and the window's extra local day (a 168h span covers EIGHT
 * local days once a 23h day is inside it) survives the group cap.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../infra/prices.js', () => ({
  getTokenPrice: async () => ({ usd: 1, eur: 0.9, sek: 10.76 }),
}))

import {
  ACTIVITY_GROUP_LIMIT,
  ACTIVITY_WINDOW_DAYS,
  ACTIVITY_WINDOW_MS,
  activityWindowStartIso,
  buildActivityFeed,
  buildActivityGroups,
  isInsideActivityWindow,
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

const sec = (iso: string): number => Math.floor(Date.parse(iso) / 1000)

describe('isInsideActivityWindow — the rolling 168h predicate (#3975)', () => {
  // The exact scenario the issue observed: 2026-10-15 09:12 Europe/Stockholm
  // (07:12 UTC) and a payment at 2026-10-08 13:48 local (11:48 UTC). The
  // rolling window starts 2026-10-08 07:12 UTC, so the payment is INSIDE —
  // under the old 7-local-day window (Oct 9–15) it was dropped, and the
  // header counted a payment the Activity card never showed.
  it('admits the observed payment: 13:48 Stockholm inside a window opened 07:12 UTC', async () => {
    const now = Date.parse('2026-10-15T07:12:00Z') // 09:12 CEST
    const payment = sec('2026-10-08T11:48:00Z') // 13:48 CEST

    expect(isInsideActivityWindow(payment, now)).toBe(true)
    expect(activityWindowStartIso(now)).toBe('2026-10-08T07:12:00.000Z')

    const groups = await buildActivityGroups({
      transactions: [row({ timestamp: payment })],
      truncated: false,
      tz: 'Europe/Stockholm',
      now,
    })
    expect(groups).toHaveLength(1)
    // Still bucketed under its own local day — the heading, not the window.
    expect(groups[0].latestAt).toBe('2026-10-08T11:48:00.000Z')
  })

  it('admits a payment exactly at the window start and rejects one second before', () => {
    const now = Date.parse('2026-10-15T07:12:00Z')
    const cutoffSec = Math.floor((now - ACTIVITY_WINDOW_MS) / 1000)
    expect(isInsideActivityWindow(cutoffSec, now)).toBe(true)
    expect(isInsideActivityWindow(cutoffSec - 1, now)).toBe(false)
  })

  it('flags a feed that only carries older activity, beside rows inside the window (#3944)', async () => {
    const now = Date.parse('2026-10-15T07:12:00Z')
    const inside = sec('2026-10-14T06:00:00Z')
    const outside = sec('2026-10-08T07:11:59Z') // one second before the cutoff

    const feed = await buildActivityFeed({
      transactions: [row({ timestamp: inside }), row({ timestamp: outside })],
      truncated: false,
      tz: 'Europe/Stockholm',
      now,
    })
    // The out-of-window row is dropped from the GROUPS but still sets the
    // flag — the empty 7-day list and "activity exists" are independent.
    expect(feed.groups).toHaveLength(1)
    expect(feed.hasOlderActivity).toBe(true)
    expect(feed.windowDays).toBe(ACTIVITY_WINDOW_DAYS)
    // The boundary rides the wire: the client marks the oldest day heading
    // partial from THIS instant, not a second clock of its own.
    expect(feed.windowStartIso).toBe('2026-10-08T07:12:00.000Z')
  })
})

describe('isInsideActivityWindow — the boundary holds at every instant', () => {
  // The successor of the old 10-zone consecutiveness sweep: the new predicate
  // has no zone arithmetic to break, so what is swept is the BOUNDARY itself,
  // over every hour of the two DST transition months — at no instant does the
  // window admit its own start minus one second, or reject its own start.
  it('a payment at the window start is always in, one second before never is', () => {
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
        for (
          let ms = Date.parse(monthStart);
          ms < Date.parse(monthStart) + 31 * 86_400_000;
          ms += 3_600_000
        ) {
          instants += 1
          const cutoffSec = Math.floor((ms - ACTIVITY_WINDOW_MS) / 1000)
          expect(isInsideActivityWindow(cutoffSec, ms), `${tz} @ ${new Date(ms).toISOString()}`).toBe(true)
          expect(isInsideActivityWindow(cutoffSec - 1, ms), `${tz} @ ${new Date(ms).toISOString()}`).toBe(false)
          // The wire instant and the predicate agree at every clock.
          expect(Date.parse(activityWindowStartIso(ms))).toBe((cutoffSec) * 1000)
          // The day key still resolves for the sweep zones (the group key
          // needs it) — the tz parameter's remaining job.
          expect(localDayKey(cutoffSec, tz)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        }
      }
    }
    expect(instants).toBeGreaterThan(10 * 30 * 24)
  }, 60_000)
})

describe('buildActivityGroups — pinned DST clocks on the rolling window', () => {
  it('keeps the transition day’s payments groupable on the morning after a 23h day', async () => {
    // Europe/Stockholm, 2026-03-30 00:20 CEST — the #3869 production bug
    // window. One payment on the 23h transition day (2026-03-29), one right
    // now. Both sit inside the rolling 168h, so both must group; under the
    // original fixed-offset sampling the transition day was lost entirely.
    const now = Date.parse('2026-03-29T22:20:00Z')
    const transactions = [
      row({ timestamp: sec('2026-03-29T12:00:00Z') }), // 14:00 CEST on the transition day
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
    expect(groups[1].latestAt).toBe('2026-03-29T12:00:00.000Z')
  })

  it('survives the morning after a 25h fall-back day too (Europe/Stockholm 2026-10-26 00:20 CET)', async () => {
    // The negative control, carried over from #3869: the 25h day's payments
    // group as well, under their own local day.
    const now = Date.parse('2026-10-25T23:20:00Z') // 00:20 CET Mon Oct 26
    const groups = await buildActivityGroups({
      transactions: [
        row({ timestamp: sec('2026-10-25T12:00:00Z') }), // 13:00 CET, the 25h day
        row({ timestamp: Math.floor(now / 1000) }),
      ],
      truncated: false,
      tz: 'Europe/Stockholm',
      now,
    })
    expect(groups).toHaveLength(2)
    expect(groups[1].latestAt).toBe('2026-10-25T12:00:00.000Z')
  })

  it('the window spans EIGHT local days after a 23h day, and all eight survive the group cap', async () => {
    // 168h is longer than seven local days whenever a 23h day sits inside it:
    // with `now` on the morning after Stockholm's spring-forward, the window
    // reaches back to 2026-03-22 22:20 UTC — 23:20 CET on Mar 22 — so the
    // local days Mar 22 through Mar 29 are all in. The old seven-local-day
    // window structurally capped at seven days and dropped the eighth; the
    // rolling window keeps it (and exactly fits the 8-group cap).
    const now = Date.parse('2026-03-29T22:20:00Z')
    const days = [
      sec('2026-03-22T22:20:00Z'), // exactly the window start (23:20 CET Mar 22)
      sec('2026-03-23T12:00:00Z'),
      sec('2026-03-24T12:00:00Z'),
      sec('2026-03-25T12:00:00Z'),
      sec('2026-03-26T12:00:00Z'),
      sec('2026-03-27T12:00:00Z'),
      sec('2026-03-28T12:00:00Z'),
      sec('2026-03-29T12:00:00Z'), // the 23h transition day
    ]
    expect(new Set(days.map((ts) => localDayKey(ts, 'Europe/Stockholm'))).size).toBe(8)

    const groups = await buildActivityGroups({
      transactions: days.map((timestamp) => row({ timestamp })),
      truncated: false,
      tz: 'Europe/Stockholm',
      now,
    })
    expect(groups).toHaveLength(ACTIVITY_GROUP_LIMIT)
    // The oldest group is the one ON the window boundary — the day heading
    // the client will mark partial (its day starts before the window does).
    expect(groups[groups.length - 1].latestAt).toBe('2026-03-22T22:20:00.000Z')
  })

  it('a feed row one second older than the eighth day is outside the window, not a ninth group', async () => {
    const now = Date.parse('2026-03-29T22:20:00Z')
    const feed = await buildActivityFeed({
      transactions: [
        row({ timestamp: sec('2026-03-22T22:19:59Z') }), // one second before the window start
        row({ timestamp: sec('2026-03-29T12:00:00Z') }),
      ],
      truncated: false,
      tz: 'Europe/Stockholm',
      now,
    })
    expect(feed.groups).toHaveLength(1)
    expect(feed.hasOlderActivity).toBe(true)
  })
})
