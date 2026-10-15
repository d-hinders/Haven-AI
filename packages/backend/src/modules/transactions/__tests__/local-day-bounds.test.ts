/**
 * `localDayBounds` — the pure half of the #3977 fix. The route hands the
 * bounds it derives here to the SQL as parameters, so the zone math is
 * pinned exactly: each zone's own midnight, through both DST flavors, never
 * a session or server default. (The route-level proof lives in
 * `routes/__tests__/agent-activity-stats-local-day.db.test.ts`.)
 */
import { describe, expect, it } from 'vitest'
import { localDayBounds } from '../activity.js'

describe('localDayBounds (#3977)', () => {
  it('cuts Europe/Stockholm on the zone day, winter (CET, +01:00)', () => {
    // 2026-03-08 23:30 local — local day 2026-03-08.
    expect(localDayBounds(Date.parse('2026-03-08T22:30:00Z'), 'Europe/Stockholm')).toEqual({
      startIso: '2026-03-07T23:00:00.000Z',
      endIso: '2026-03-08T23:00:00.000Z',
    })
  })

  it('cuts Europe/Stockholm on the zone day, summer (CEST, +02:00) — 00:30 local is already the next day', () => {
    // 2026-07-09 00:30 local — local day 2026-07-09 starts 22:00Z the evening before.
    expect(localDayBounds(Date.parse('2026-07-08T22:30:00Z'), 'Europe/Stockholm')).toEqual({
      startIso: '2026-07-08T22:00:00.000Z',
      endIso: '2026-07-09T22:00:00.000Z',
    })
  })

  it('defaults to the UTC day shape for UTC', () => {
    expect(localDayBounds(Date.parse('2026-05-08T11:50:00Z'), 'UTC')).toEqual({
      startIso: '2026-05-08T00:00:00.000Z',
      endIso: '2026-05-09T00:00:00.000Z',
    })
  })

  it('a clock exactly on local midnight still yields the full day, not a zero-width window', () => {
    // 2026-03-08T23:00Z is 00:00 CET on the 9th — the local day is 2026-03-09
    // and its end is the NEXT midnight, not the clock instant itself (the end
    // is derived from the start day).
    expect(localDayBounds(Date.parse('2026-03-08T23:00:00Z'), 'Europe/Stockholm')).toEqual({
      startIso: '2026-03-08T23:00:00.000Z',
      endIso: '2026-03-09T23:00:00.000Z',
    })
  })

  it('survives a spring-forward day — America/New_York, a 23h local day', () => {
    // 2026-03-08: clocks jump 02:00 → 03:00 local. The local day runs
    // 00:00 EST (05:00Z) to 00:00 EDT (04:00Z) — 23 hours, both ends exact.
    expect(localDayBounds(Date.parse('2026-03-08T12:00:00Z'), 'America/New_York')).toEqual({
      startIso: '2026-03-08T05:00:00.000Z',
      endIso: '2026-03-09T04:00:00.000Z',
    })
  })

  it('survives a southern-hemisphere zone on DST (Sydney, AEDT +11)', () => {
    // 2026-10-07 09:30 local — the day runs 13:00Z (Oct 6) to 13:00Z (Oct 7).
    expect(localDayBounds(Date.parse('2026-10-06T23:30:00Z'), 'Australia/Sydney')).toEqual({
      startIso: '2026-10-06T13:00:00.000Z',
      endIso: '2026-10-07T13:00:00.000Z',
    })
  })
})
