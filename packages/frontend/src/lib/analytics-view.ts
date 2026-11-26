/**
 * The Analytics page's Spending / Revenue switch, as a URL state (#4901, epic
 * #4885).
 *
 * The switch is a PAGE DATA-SOURCE switch, not a sub-view of one surface
 * (`docs/product/design-system.md` § Tabs): it changes what the whole page
 * reads — every tile, chart and list below it — so it is held in `?view=`
 * beside `?period=`, the way the period is, and not in `?tab=` the way the
 * account page's Activity / Agents tabs are.
 *
 * Two jobs, both free of React so they are testable as plain functions and so
 * the URL can be read inside the `useState` initialiser rather than in an
 * effect — the same reasoning `lib/analytics-range.ts` records: a value read
 * in an effect would fire a second request on every mount of a device that
 * chose Revenue, and flash the wrong side for the frames before it settles.
 *
 * The side is NOT persisted to localStorage. The period is a device
 * preference (`haven.analytics.range`); the side is a linkable state, like the
 * Agent facet — a shared `/analytics?view=revenue&period=7d` link opens on the
 * revenue side for the window it names, on any device.
 */

/** The two sides of the page. `spending` is the page as it shipped. */
export type AnalyticsView = 'spending' | 'revenue'

/** The URL key the switch mirrors its selection onto, beside `period`. */
export const ANALYTICS_VIEW_URL_PARAM = 'view'

/** The side a page with no `?view=` opens on: the page as it shipped. */
export const DEFAULT_ANALYTICS_VIEW: AnalyticsView = 'spending'

/** The switch's options, in the order the mockup shows them (#4894). */
export const ANALYTICS_VIEW_OPTIONS: ReadonlyArray<{ value: AnalyticsView; label: string }> = [
  { value: 'spending', label: 'Spending' },
  { value: 'revenue', label: 'Revenue' },
]

/**
 * The one predicate that says whether a value may be trusted as a side. A
 * hand-edited or stale `?view=` falls back to the default rather than reaching
 * the page as an unknown state — the same gate `isAnalyticsRangeValue` is for
 * the period.
 */
export function isAnalyticsView(value: unknown): value is AnalyticsView {
  return value === 'spending' || value === 'revenue'
}

/**
 * The `?view=` on the address bar, or `null` when there is none or it is not a
 * side this page has. Read in the `useState` initialiser, so the FIRST render
 * already knows which side it is on and no request is spent on the other one.
 */
export function readUrlAnalyticsView(): AnalyticsView | null {
  if (typeof window === 'undefined') return null
  try {
    const value = new URLSearchParams(window.location.search).get(ANALYTICS_VIEW_URL_PARAM)
    return isAnalyticsView(value) ? value : null
  } catch {
    return null
  }
}

/**
 * Mirror the chosen side onto the address bar with `replaceState` — no history
 * entry per change, the posture `writeUrlAnalyticsRange` and `useListUrlState`
 * set (#4110) — so a reload or a shared link reopens the side on screen. Only
 * the `view` key is written: `period` and `agentId` are preserved, and a write
 * that throws (a frozen history in an embedded context) is swallowed, because
 * the URL mirrors the choice while React state already holds it.
 *
 * The default side is written too, not deleted: the acceptance criterion is
 * that the chosen side is HELD in the address next to the period, and a
 * `?view=spending` link says which side it opens on without the reader having
 * to know the default.
 */
export function writeUrlAnalyticsView(value: AnalyticsView): void {
  if (!isAnalyticsView(value)) return
  if (typeof window === 'undefined') return
  try {
    const params = new URLSearchParams(window.location.search)
    params.set(ANALYTICS_VIEW_URL_PARAM, value)
    const search = params.toString()
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`,
    )
  } catch {
    // See the docblock: the URL mirrors the choice, it is not the source of it.
  }
}
