'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { browserTimeZone } from '@/lib/analytics-range'
import type { AnalyticsOverviewResponse, AnalyticsRangeValue } from '@/types/analytics'

/** The display currency the Settings surface stores, lower-cased for the wire. */
export type AnalyticsCurrencyParam = 'usd' | 'eur' | 'sek'

export type UseAnalyticsOverviewResult = {
  data: AnalyticsOverviewResponse | null
  loading: boolean
  /** True when the most recent completed request for this window failed. */
  failed: boolean
  refetch: () => void
}

/**
 * `GET /analytics/overview` for one (range, currency) pair (#2947, slice C).
 *
 * One request per window, which is what the endpoint exists to provide — its
 * own description in the spec says the page should have "one loading state and
 * one 'based on N payments' basis". So this hook does not fan out into
 * per-tile fetches, and it does not poll: the figures are a report over
 * history rather than a live tape, and re-running a full aggregate every few
 * seconds would buy no figure that changes on its own.
 *
 * `tz` is the browser's IANA zone, so the server buckets `by_day` on the days
 * the reader lives in. The spec rejects offsets and abbreviations, so only a
 * zone name is ever sent; when the runtime cannot resolve one the parameter is
 * omitted and the server's documented UTC default takes over.
 */
export function useAnalyticsOverview(
  range: AnalyticsRangeValue,
  currency: AnalyticsCurrencyParam,
): UseAnalyticsOverviewResult {
  const [data, setData] = useState<AnalyticsOverviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const requestIdRef = useRef(0)

  // Rebuilt only when an input that changes the answer changes, so a
  // re-render that alters nothing cannot issue a second request for the same
  // window.
  const path = useMemo(() => {
    const params = new URLSearchParams({ range, currency })
    const zone = browserTimeZone()
    if (zone !== undefined) params.set('tz', zone)
    return `/analytics/overview?${params.toString()}`
  }, [range, currency])

  const load = useCallback(
    async (requestId: number) => {
      try {
        const response = await api.get<AnalyticsOverviewResponse>(path)
        // A superseded response (the reader moved the range while this was in
        // flight) must not write state: the newer request already owns the
        // screen, and painting an older window over it is how two ranges end
        // up on one page.
        if (requestIdRef.current !== requestId) return
        setData(response)
        setFailed(false)
      } catch {
        if (requestIdRef.current !== requestId) return
        // The error state renders fixed copy the page owns, never this
        // message: whatever the server said, the reader is told what did not
        // load and what they can do about it, and nothing is echoed back from
        // the failure.
        setFailed(true)
      } finally {
        if (requestIdRef.current === requestId) setLoading(false)
      }
    },
    [path],
  )

  useEffect(() => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    setFailed(false)
    void load(requestId)
    return () => {
      // Invalidate the in-flight request for this window. Both write paths
      // above are guarded by the same counter, so a late answer cannot write
      // state after unmount.
      requestIdRef.current += 1
    }
  }, [load])

  const refetch = useCallback(() => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    setFailed(false)
    void load(requestId)
  }, [load])

  return { data, loading, failed, refetch }
}

/**
 * How many days of the window carry a recorded figure.
 *
 * `by_day` holds an entry for a day only when that day has a spend row or a
 * refusal row (`routes/analytics-overview.ts`, the map that builds it is fed
 * solely by those two queries), so its length is the count of days with
 * history rather than the length of the window. That is what makes the sparse
 * rule below meaningful: a three-day-old account on a 90-day range has one or
 * two entries here while `range.days` reads 90, and the second number would
 * draw three charts' worth of empty axis and call it data.
 */
export function analyticsDaysWithData(data: AnalyticsOverviewResponse | null): number {
  if (data === null) return 0
  return data.by_day.length
}
