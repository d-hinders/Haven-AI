'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { useVisiblePolling } from '@/hooks/useVisiblePolling'
import { browserTimeZone } from '@/lib/analytics-range'
import type { DashboardOverviewResponse } from '@/types/dashboard'

export function useDashboardOverview() {
  const [data, setData] = useState<DashboardOverviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  // #3810: the overview's activity groups bucket by the user's LOCAL day, so
  // the request names the zone — the browser's IANA name, exactly as
  // `/analytics/overview` receives its `tz` (same validation server-side, and
  // the same `browserTimeZone` rule: an unresolvable zone is omitted and the
  // documented UTC default takes over, never a guess). The path is memoized
  // so a re-render that changes nothing cannot re-issue the request.
  const path = useMemo(() => {
    const params = new URLSearchParams()
    const zone = browserTimeZone()
    if (zone !== undefined) params.set('tz', zone)
    const query = params.toString()
    return query ? `/dashboard/overview?${query}` : '/dashboard/overview'
  }, [])

  const fetchOverview = useCallback(async (silent = false) => {
    const requestId = ++requestIdRef.current
    try {
      if (!silent) {
        setLoading(true)
        setError(null)
      }
      const response = await api.get<DashboardOverviewResponse>(path)
      if (requestIdRef.current !== requestId) return

      setData(response)
      // A silent tick that SUCCEEDS clears a stale error banner; the AC only
      // forbids a FAILED tick from changing visible state.
      if (silent) setError(null)
    } catch (err) {
      if (requestIdRef.current === requestId && !silent) {
        setError(err instanceof Error ? err.message : 'Failed to load dashboard overview')
      }
    } finally {
      // No silent check: a silent tick that superseded a dropped fetch still
      // has to release the skeleton that fetch set (its finally was skipped
      // by the requestId guard, so this is the only release left).
      if (requestIdRef.current === requestId) {
        setLoading(false)
      }
    }
  }, [path])

  useEffect(() => {
    fetchOverview()
    return () => {
      requestIdRef.current += 1
    }
  }, [fetchOverview])

  useVisiblePolling(() => {
    void fetchOverview(true)
  })

  return {
    data,
    loading,
    error,
    refetch: fetchOverview,
  }
}
