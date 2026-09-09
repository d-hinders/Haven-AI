'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { useVisiblePolling } from '@/hooks/useVisiblePolling'
import type { DashboardOverviewResponse } from '@/types/dashboard'

export function useDashboardOverview() {
  const [data, setData] = useState<DashboardOverviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  // #2732: the `silent` variant (used by visible-only polling) must change no
  // visible state on a failed tick — the demo screen keeps its last good
  // values instead of flipping to an error branch mid-presentation.
  const fetchOverview = useCallback(async (silent = false) => {
    const requestId = ++requestIdRef.current
    try {
      if (!silent) {
        setLoading(true)
        setError(null)
      }
      const response = await api.get<DashboardOverviewResponse>('/dashboard/overview')
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
  }, [])

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
