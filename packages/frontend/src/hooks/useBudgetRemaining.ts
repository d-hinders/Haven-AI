'use client'

/**
 * The dashboard's cached budget-remaining poll (#3804).
 *
 * Reads `GET /dashboard/budget-remaining` — per budget the cached enforcer
 * read (`remaining_atomic`), whether it came from the chain, and the
 * Postgres-only sub-budget spend attribution. The BACKEND caches the chain
 * reads on their own 60 s cadence; this hook paces ITS polls to match
 * (60 s + window focus) instead of the 10 s default, so a poll cannot ask
 * faster than the cache can refresh — the poll that outruns the cache would
 * just re-read the same entry.
 *
 * Same state contract as `useDashboardOverview`: fetch on mount, silent
 * refetch on ticks (a failed tick changes no visible state — the last good
 * values stay up, and an entry whose read went unknown carries
 * `remaining_atomic: null`, which the renderer shows as unavailable rather
 * than "0 left" or the full budget).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { useVisiblePolling } from '@/hooks/useVisiblePolling'
import type { ApiSchema } from '@haven_ai/core'

export type DashboardBudgetRemainingResponse = ApiSchema<'DashboardBudgetRemainingResponse'>

/** Matches the backend cache TTL — the fastest a poll can learn anything new. */
export const BUDGET_REMAINING_POLL_INTERVAL_MS = 60_000

export function useBudgetRemaining() {
  const [data, setData] = useState<DashboardBudgetRemainingResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  const fetchBudgets = useCallback(async (silent = false) => {
    const requestId = ++requestIdRef.current
    try {
      if (!silent) {
        setLoading(true)
        setError(null)
      }
      const response = await api.get<DashboardBudgetRemainingResponse>(
        '/dashboard/budget-remaining',
      )
      if (requestIdRef.current !== requestId) return

      setData(response)
      if (silent) setError(null)
    } catch (err) {
      if (requestIdRef.current === requestId && !silent) {
        setError(err instanceof Error ? err.message : 'Failed to load budget remaining')
      }
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    fetchBudgets()
    return () => {
      requestIdRef.current += 1
    }
  }, [fetchBudgets])

  useVisiblePolling(() => {
    void fetchBudgets(true)
  }, BUDGET_REMAINING_POLL_INTERVAL_MS)

  return {
    data,
    loading,
    error,
    refetch: fetchBudgets,
  }
}
