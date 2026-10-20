/**
 * `parseTransactionWindow` — the Period filter's pure half (#4095).
 *
 * The presets are ROLLING windows `[now − N×24h, now)` (owner rule, epic
 * #3801 — rolling days, no calendar month); the custom range cuts calendar
 * days in the caller's zone, inclusive of BOTH end days, through DST exactly
 * the way `localDayBounds` cuts them (#3977).
 */
import { describe, expect, it } from 'vitest'
import { parseTransactionWindow } from '../period.js'

const NOW = Date.parse('2026-10-19T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

describe('parseTransactionWindow (#4095)', () => {
  it('absent parameters mean no filter — window is undefined', () => {
    expect(parseTransactionWindow({}, NOW)).toEqual({ ok: true, window: undefined })
  })

  it('presets are rolling windows [now − N×24h, now) — start inclusive, end exclusive', () => {
    expect(parseTransactionWindow({ period: '7d' }, NOW)).toEqual({
      ok: true,
      window: { startMs: NOW - 7 * DAY, endMs: NOW },
    })
    expect(parseTransactionWindow({ period: '30d' }, NOW)).toEqual({
      ok: true,
      window: { startMs: NOW - 30 * DAY, endMs: NOW },
    })
    expect(parseTransactionWindow({ period: '90d' }, NOW)).toEqual({
      ok: true,
      window: { startMs: NOW - 90 * DAY, endMs: NOW },
    })
  })

  it('an unknown preset is a structured error, not a silent no-filter', () => {
    expect(parseTransactionWindow({ period: '14d' }, NOW)).toEqual({
      ok: false,
      error: 'Invalid period',
    })
  })

  it('a custom single-day range in UTC is that whole day — inclusive of both ends', () => {
    expect(parseTransactionWindow({ from: '2026-05-08', to: '2026-05-08' }, NOW)).toEqual({
      ok: true,
      window: {
        startMs: Date.parse('2026-05-08T00:00:00.000Z'),
        endMs: Date.parse('2026-05-09T00:00:00.000Z'),
      },
    })
  })

  it('the custom range spans to the END of the `to` day, not its midnight', () => {
    expect(parseTransactionWindow({ from: '2026-05-07', to: '2026-05-08' }, NOW)).toEqual({
      ok: true,
      window: {
        startMs: Date.parse('2026-05-07T00:00:00.000Z'),
        endMs: Date.parse('2026-05-09T00:00:00.000Z'),
      },
    })
  })

  it('cuts the zone day through winter DST — Europe/Stockholm, CET', () => {
    // 2026-03-08 local (CET, +01:00) starts 23:00Z; the range ends at the
    // next zone midnight, 2026-03-09T23:00Z.
    expect(parseTransactionWindow({ from: '2026-03-08', to: '2026-03-08', tz: 'Europe/Stockholm' }, NOW)).toEqual({
      ok: true,
      window: {
        startMs: Date.parse('2026-03-07T23:00:00.000Z'),
        endMs: Date.parse('2026-03-08T23:00:00.000Z'),
      },
    })
  })

  it('cuts the zone day through summer DST — Europe/Stockholm, CEST', () => {
    // 2026-07-09 00:30 local is already 2026-07-08T22:00Z.
    expect(parseTransactionWindow({ from: '2026-07-09', to: '2026-07-09', tz: 'Europe/Stockholm' }, NOW)).toEqual({
      ok: true,
      window: {
        startMs: Date.parse('2026-07-08T22:00:00.000Z'),
        endMs: Date.parse('2026-07-09T22:00:00.000Z'),
      },
    })
  })

  it('defaults the zone to UTC', () => {
    expect(parseTransactionWindow({ from: '2026-05-08', to: '2026-05-09' }, NOW)).toEqual({
      ok: true,
      window: {
        startMs: Date.parse('2026-05-08T00:00:00.000Z'),
        endMs: Date.parse('2026-05-10T00:00:00.000Z'),
      },
    })
  })

  it('a from-after-to range is a structured 400', () => {
    expect(parseTransactionWindow({ from: '2026-05-09', to: '2026-05-08' }, NOW)).toEqual({
      ok: false,
      error: 'from is after to',
    })
  })

  it('an invalid tz is a structured 400 — the dashboard/analytics rule', () => {
    expect(parseTransactionWindow({ from: '2026-05-08', to: '2026-05-08', tz: 'Not/AZone' }, NOW)).toEqual({
      ok: false,
      error: 'unsupported tz',
    })
    // An offset string is refused too — Intl accepts far more than IANA names.
    expect(parseTransactionWindow({ from: '2026-05-08', to: '2026-05-08', tz: '+02:00' }, NOW)).toEqual({
      ok: false,
      error: 'unsupported tz',
    })
  })

  it('a well-formed but non-existent calendar date is a structured 400', () => {
    expect(parseTransactionWindow({ from: '2026-02-31', to: '2026-03-01' }, NOW)).toEqual({
      ok: false,
      error: 'from and to must be calendar dates (YYYY-MM-DD)',
    })
  })

  it('a malformed calendar date is a structured 400', () => {
    expect(parseTransactionWindow({ from: '08.05.2026', to: '2026-05-09' }, NOW)).toEqual({
      ok: false,
      error: 'from and to must be calendar dates (YYYY-MM-DD)',
    })
  })

  it('`from` and `to` must travel together', () => {
    expect(parseTransactionWindow({ from: '2026-05-08' }, NOW)).toEqual({
      ok: false,
      error: 'from and to must be sent together',
    })
    expect(parseTransactionWindow({ to: '2026-05-08' }, NOW)).toEqual({
      ok: false,
      error: 'from and to must be sent together',
    })
  })

  it('a preset and a custom range are mutually exclusive, not silently prioritised', () => {
    expect(parseTransactionWindow({ period: '7d', from: '2026-05-08', to: '2026-05-09' }, NOW)).toEqual({
      ok: false,
      error: 'period and from/to are mutually exclusive',
    })
  })
})
