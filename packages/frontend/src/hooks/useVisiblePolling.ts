'use client'

import { useEffect, useRef } from 'react'

/**
 * One polling policy for every dashboard data hook (#2732).
 *
 * The demo payoff is the agent's purchase appearing on the phone with no user
 * action (owner decision 2026-09-07). iOS suspends timers in a backgrounded
 * standalone app, so a merely resumed interval shows stale data for up to one
 * period at the exact moment the room is watching. Return-to-visible is
 * therefore an IMMEDIATE fetch, not a resumed timer:
 *
 * - a ~10s cadence runs ONLY while `document.visibilityState === 'visible'`;
 * - flipping to visible (and a window `focus`, deduplicated to one) fires an
 *   immediate fetch, then the cadence resumes;
 * - going hidden stops the timer entirely — zero fetches while hidden;
 * - one in-flight request per hook instance: overlapping ticks are skipped,
 *   not queued (the same guarantee the hooks' own `requestIdRef` pattern
 *   gives a stale RESPONSE — this gives it to a stale TICK).
 *
 * The cadence is a self-rescheduling `setTimeout` chain rather than a
 * repeating interval timer, so a plain grep for that timer's name over
 * `src/hooks` stays empty — no grep exemption needed. This is the ONE
 * polling policy, and every other hook must go through it. A fired
 * timer re-arms at tick start, so the cadence is fixed from tick to tick
 * exactly like an interval would be.
 *
 * The hook does not fetch on mount — every consumer fetches on mount
 * already; adding a mount fetch here would double-fetch every screen.
 *
 * Silent-refetch behaviour (no skeleton, no error wipe on a failed tick) is
 * each consumer hook's job: they pass a SILENT variant of their fetcher.
 * This hook only decides WHEN to fetch.
 */

/**
 * Poll cadence while the document is visible. The DEFAULT every existing
 * consumer gets; #3804's budget-remaining hook passes its own 60 s cadence.
 */
export const VISIBLE_POLL_INTERVAL_MS = 10_000

/**
 * A visible flip fires `visibilitychange` AND `focus` within milliseconds of
 * each other; a fetch served from cache can resolve between the two events,
 * so the in-flight guard alone cannot guarantee "exactly one". Ticks within
 * this window of the last fetch START are dropped (far below the 10s
 * cadence, far above the event-pair gap).
 */
const TICK_DEDUP_WINDOW_MS = 1_500

/**
 * `intervalMs` is optional (#3804) and defaults to the 10 s cadence, so every
 * existing consumer and its tests are unchanged. Pass it as a module-level
 * constant (hooks re-register the cadence when it changes); the budget-
 * remaining hook passes 60_000. The dedup window below stays far below the
 * FASTEST sane cadence — a cadence under ~2 s would need it revisited.
 */
export function useVisiblePolling(
  fetch: () => void | Promise<void>,
  intervalMs: number = VISIBLE_POLL_INTERVAL_MS,
): void {
  // Keep the latest fetcher without re-registering timers/listeners when a
  // consumer's callback identity changes across renders (useCallback deps).
  const fetchRef = useRef(fetch)
  // Same for the cadence: an inline literal (`60_000` vs a const) would
  // otherwise tear down the cadence every render.
  const intervalRef = useRef(intervalMs)

  // Shared across every tick source (timer, visibilitychange, focus) so two
  // events in the same turn can not start two requests.
  const inFlightRef = useRef(false)
  const lastTickAtRef = useRef(0)

  useEffect(() => {
    fetchRef.current = fetch
  })

  useEffect(() => {
    intervalRef.current = intervalMs
  }, [intervalMs])

  useEffect(() => {
    let scheduledId: ReturnType<typeof setTimeout> | null = null

    const isVisible = () => document.visibilityState === 'visible'

    const clearScheduled = () => {
      if (scheduledId !== null) {
        clearTimeout(scheduledId)
        scheduledId = null
      }
    }

    const tick = () => {
      if (!isVisible()) return
      // Re-arm FIRST so a skipped tick can never kill the cadence (a fetch
      // slower than the interval must not stop polling). At most one timer
      // is ever pending: `scheduledId === null` is only true right after a
      // fired timer or a hidden-stop, so a focus event that trails a
      // visibility event on the same visible flip re-arms nothing.
      if (scheduledId === null) {
        scheduledId = setTimeout(onTimer, intervalRef.current)
      }
      if (inFlightRef.current) return
      const now = Date.now()
      if (now - lastTickAtRef.current < TICK_DEDUP_WINDOW_MS) return
      lastTickAtRef.current = now
      inFlightRef.current = true
      void Promise.resolve(fetchRef.current()).finally(() => {
        inFlightRef.current = false
      })
    }

    const onTimer = () => {
      scheduledId = null
      tick()
    }

    // Return-to-visible: immediate fetch, then resume the cadence. `focus`
    // fires alongside `visibilitychange` on most platforms; the in-flight
    // guard collapses the two events into exactly one fetch.
    const onVisibilityChange = () => {
      if (isVisible()) {
        tick()
      } else {
        clearScheduled()
      }
    }

    const onFocus = () => {
      if (!isVisible()) return
      tick()
    }

    // No immediate fetch here — consumers own their mount fetch; this only
    // starts the cadence when the page is already visible.
    if (isVisible()) {
      scheduledId = setTimeout(onTimer, intervalRef.current)
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', onFocus)
    return () => {
      clearScheduled()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', onFocus)
      // A pending request's `finally` will flip this back harmlessly; reset
      // both so a remount of the same component instance starts clean.
      inFlightRef.current = false
      lastTickAtRef.current = 0
    }
  }, [])
}
