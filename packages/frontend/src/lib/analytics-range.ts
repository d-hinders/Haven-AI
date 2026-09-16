/**
 * The Analytics range control's pure half (#2947, epic #2944 slice C).
 *
 * Two jobs, both deliberately free of React so they are testable as plain
 * functions and so the STORAGE half can be read inside the `useState`
 * initialiser rather than in an effect:
 *
 *   - reading the stored range during the initialiser means the FIRST request
 *     already carries the persisted value. The alternative — default to 30d,
 *     then an effect that reads storage and refetches — fires a second
 *     `GET /analytics/overview` on every mount of a device that has chosen
 *     7d or 90d, and flashes the wrong window for the frames before it
 *     settles. The same reasoning is what put `haven.theme` in a <head> script
 *     rather than in an effect (#2927).
 *   - storage access is inside try/catch because private mode and blocked
 *     storage must not break the page: a device that cannot persist simply
 *     falls back to the default each visit, which is a degraded preference,
 *     not a broken screen.
 */

export type AnalyticsRangeValue = '7d' | '30d' | '90d'

/** The storage key, following `THEME_STORAGE_KEY`'s `haven.<thing>` shape. */
export const ANALYTICS_RANGE_STORAGE_KEY = 'haven.analytics.range'

/**
 * The window a device with no stored choice gets. 30d: long enough that a
 * fresh account has a real shape to read and the budget bands mean something,
 * short enough that a 90d account's stale agent does not dominate the page.
 */
export const DEFAULT_ANALYTICS_RANGE: AnalyticsRangeValue = '30d'

/** The control's options in the order they are shown. */
export const ANALYTICS_RANGE_OPTIONS: ReadonlyArray<{ value: AnalyticsRangeValue; label: string }> = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
]

/**
 * The one predicate that says whether a value may be trusted as a range.
 *
 * The server validates the same enum and answers 400 on anything else
 * (`routes/analytics-overview.ts`), so trusting storage would hand a corrupt
 * or stale key straight to a guaranteed 400 — the whole page would fall into
 * its error state because of one bad string in localStorage. Both readers
 * below funnel through this check for that reason, not for tidiness.
 */
export function isAnalyticsRangeValue(value: unknown): value is AnalyticsRangeValue {
  return value === '7d' || value === '30d' || value === '90d'
}

/**
 * The range to render at first paint: the stored choice when it is still a
 * value the endpoint accepts, the default otherwise.
 */
export function readStoredAnalyticsRange(): AnalyticsRangeValue {
  if (typeof window === 'undefined') return DEFAULT_ANALYTICS_RANGE
  try {
    const stored = window.localStorage.getItem(ANALYTICS_RANGE_STORAGE_KEY)
    return isAnalyticsRangeValue(stored) ? stored : DEFAULT_ANALYTICS_RANGE
  } catch {
    return DEFAULT_ANALYTICS_RANGE
  }
}

/**
 * Remember the choice for this device. A write that throws (private mode, a
 * full or blocked store) is swallowed on purpose: the selection the user just
 * made is already in React state and already on screen, so a device that
 * cannot persist must keep working for this visit rather than lose the
 * interaction to a storage exception.
 */
export function writeStoredAnalyticsRange(value: AnalyticsRangeValue): void {
  if (!isAnalyticsRangeValue(value)) return
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(ANALYTICS_RANGE_STORAGE_KEY, value)
  } catch {
    // See the docblock: persistence is a convenience, the selection is not.
  }
}

/**
 * The browser's own calendar zone, sent as `tz` so the server buckets `by_day`
 * on the days the user actually lives in (#2946).
 *
 * A zone that cannot be resolved — a headless or exotic runtime whose
 * `Intl` hands back `UTC` or a throw — becomes `undefined`, and the endpoint's
 * documented default then takes over. That is deliberately NOT `'UTC'`: the
 * server would then bucket in UTC while the user's calendar is not UTC, which
 * is precisely the skew `tz` exists to remove, and an unknown zone is better
 * answered by the server's own default than by a guess made here.
 */
export function browserTimeZone(): string | undefined {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof zone !== 'string' || zone.length === 0 || zone === 'UTC') return undefined
    return zone
  } catch {
    return undefined
  }
}
