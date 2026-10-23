'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiRequestError } from '@/lib/api'
import { browserTimeZone } from '@/lib/analytics-range'
import type { AnalyticsOverviewResponse, AnalyticsRangeValue } from '@/types/analytics'

/** The display currency the Settings surface stores, lower-cased for the wire. */
export type AnalyticsCurrencyParam = 'usd' | 'eur' | 'sek'

export type UseAnalyticsOverviewResult = {
  data: AnalyticsOverviewResponse | null
  loading: boolean
  /** True when the most recent completed request for this window failed. */
  failed: boolean
  /**
   * True when the most recent request failed because the `agentId` named no
   * agent of this user — the endpoint's 404 (#4332). A stale or foreign id
   * clears the filter with a notice rather than putting the whole page into
   * its error state; the page owns that recovery, this flag is its trigger.
   */
  agentNotFound: boolean
  refetch: () => void
}

/**
 * `GET /analytics/overview` for one (range, currency, agent) triple (#2947,
 * slice C; `agentId` since #4332/#4333).
 *
 * One request per window, which is what the endpoint exists to provide — its
 * own description in the spec says the page should have "one loading state and
 * one 'based on N payments' basis". So this hook does not fan out into
 * per-tile fetches, and it does not poll: the figures are a report over
 * history rather than a live tape, and re-running a full aggregate every few
 * seconds would buy no figure that changes on its own.
 *
 * `agentId` is optional and rides the SAME request when set — the endpoint
 * scopes every aggregate to one agent (#4332), and the page's Agent facet
 * writes it. A `null` agent is the unfiltered page. The id is NOT validated
 * here beyond the wire: a foreign or revoked-everywhere id is the endpoint's
 * 404, surfaced as `agentNotFound` for the page to clear with a notice.
 *
 * `tz` is the browser's IANA zone, so the server buckets `by_day` on the days
 * the reader lives in. The spec rejects offsets and abbreviations, so only a
 * zone name is ever sent; when the runtime cannot resolve one the parameter is
 * omitted and the server's documented UTC default takes over.
 */
export function useAnalyticsOverview(
  range: AnalyticsRangeValue,
  currency: AnalyticsCurrencyParam,
  agentId: string | null = null,
): UseAnalyticsOverviewResult {
  const [data, setData] = useState<AnalyticsOverviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [agentNotFound, setAgentNotFound] = useState(false)
  const requestIdRef = useRef(0)

  // Rebuilt only when an input that changes the answer changes, so a
  // re-render that alters nothing cannot issue a second request for the same
  // window. `agentId` is part of the question (#4333): the path memo includes
  // it, so picking an agent re-asks exactly once.
  const path = useMemo(() => {
    const params = new URLSearchParams({ range, currency })
    const zone = browserTimeZone()
    if (zone !== undefined) params.set('tz', zone)
    if (agentId !== null) params.set('agentId', agentId)
    return `/analytics/overview?${params.toString()}`
  }, [range, currency, agentId])

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
        setAgentNotFound(false)
      } catch (error) {
        if (requestIdRef.current !== requestId) return
        // The error state renders fixed copy the page owns, never this
        // message: whatever the server said, the reader is told what did not
        // load and what they can do about it, and nothing is echoed back from
        // the failure. The ONE exception is the agent filter's own 404 —
        // that is not a failed page but a filter naming nothing, and the page
        // clears it rather than showing the outage.
        if (error instanceof ApiRequestError && error.status === 404 && agentId !== null) {
          setAgentNotFound(true)
        } else {
          setFailed(true)
        }
      } finally {
        if (requestIdRef.current === requestId) setLoading(false)
      }
    },
    [path, agentId],
  )

  useEffect(() => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    setFailed(false)
    setAgentNotFound(false)
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
    setAgentNotFound(false)
    void load(requestId)
  }, [load])

  return { data, loading, failed, agentNotFound, refetch }
}
