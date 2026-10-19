/**
 * The Period filter for the transaction feed and export (#4095).
 *
 * Two shapes, one window. Presets are ROLLING windows `[now − N×24h, now)` —
 * the owner rule from epic #3801 (2026-10-09: "Rolling 7 and 30 days; no
 * calendar month"), the same predicate as `activity.ts`'s
 * `isInsideActivityWindow`, not calendar months. A custom range is two
 * calendar dates in the user's zone, inclusive of BOTH days — the end bound
 * is the zone midnight AFTER `to`, so `from === to` is that whole day and a
 * DST day is its real 23h/25h.
 *
 * The parser is pure and injects `now`, so the route hands ONE instant to
 * every bound and tests can pin the window exactly.
 */
import { isValidActivityTimeZone, zonedMidnightMs } from './activity.js'

export type TransactionPeriodPreset = '7d' | '30d' | '90d'

const PRESET_MS: Record<TransactionPeriodPreset, number> = {
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
}

const PRESET_KEYS = Object.keys(PRESET_MS) as TransactionPeriodPreset[]

/** Half-open instant window `[startMs, endMs)` the feed filter applies. */
export interface TransactionWindow {
  startMs: number
  endMs: number
}

export type ParsedTransactionWindow =
  | { ok: true; window?: TransactionWindow }
  | { ok: false; error: string }

export interface TransactionWindowParams {
  period?: string
  from?: string
  to?: string
  tz?: string
}

const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** `YYYY-MM-DD` → the next calendar day, same shape. */
function nextDay(day: string): string {
  const [year, month, dayOfMonth] = day.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, dayOfMonth + 1)).toISOString().slice(0, 10)
}

/**
 * Validate a custom calendar-date. `Date.UTC` (and V8's `Date.parse`)
 * CLAMP a well-formed but non-existent date forward — `2026-02-31` becomes
 * March 3 — so the midnight conversion can never signal NaN for one. The
 * rejection is the roundtrip: the date exists only when it reconstructs
 * itself, which is also why the window bounds below can never come out
 * inverted (start after end) from a clamped `from`.
 */
function parseCalendarDate(value: string): string | null {
  if (!CALENDAR_DATE_RE.test(value)) return null
  const [year, month, dayOfMonth] = value.split('-').map(Number)
  const asUtc = new Date(Date.UTC(year, month - 1, dayOfMonth))
  if (
    asUtc.getUTCFullYear() !== year ||
    asUtc.getUTCMonth() !== month - 1 ||
    asUtc.getUTCDate() !== dayOfMonth
  ) {
    return null
  }
  return value
}

/**
 * Parse the Period query parameters into one window.
 *
 * Absent parameters yield `window: undefined` — no date filter, exactly what
 * the endpoints did before the parameter existed. The three error cases the
 * acceptance criteria name are structured here so BOTH endpoints answer with
 * the same 400: an invalid `tz`, a `from` after `to`, and a malformed or
 * non-existent calendar date. Presets and custom ranges are mutually
 * exclusive rather than silently prioritising one.
 */
export function parseTransactionWindow(
  params: TransactionWindowParams,
  nowMs: number,
): ParsedTransactionWindow {
  const hasPreset = params.period !== undefined
  const hasCustom = params.from !== undefined || params.to !== undefined

  if (hasPreset && hasCustom) {
    return { ok: false, error: 'period and from/to are mutually exclusive' }
  }

  if (hasPreset) {
    if (!(PRESET_KEYS as string[]).includes(params.period!)) {
      return { ok: false, error: 'Invalid period' }
    }
    const preset = params.period as TransactionPeriodPreset
    return {
      ok: true,
      window: { startMs: nowMs - PRESET_MS[preset], endMs: nowMs },
    }
  }

  if (hasCustom) {
    if (params.from === undefined || params.to === undefined) {
      return { ok: false, error: 'from and to must be sent together' }
    }
    const from = parseCalendarDate(params.from)
    const to = parseCalendarDate(params.to)
    if (from === null || to === null) {
      return { ok: false, error: 'from and to must be calendar dates (YYYY-MM-DD)' }
    }
    if (from > to) {
      return { ok: false, error: 'from is after to' }
    }
    const tz = params.tz ?? 'UTC'
    if (!isValidActivityTimeZone(tz)) {
      return { ok: false, error: 'unsupported tz' }
    }
    return {
      ok: true,
      // `to` is inclusive of its whole zone day: the end bound is the next
      // day's local midnight, exclusive — the same half-open shape
      // `localDayBounds` hands SQL (#3977).
      window: { startMs: zonedMidnightMs(from, tz), endMs: zonedMidnightMs(nextDay(to), tz) },
    }
  }

  return { ok: true }
}
