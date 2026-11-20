'use client'

/**
 * The Sales summary read for one period (#4900, epic #4885): the tiles, the
 * chart and both breakdowns come from this ONE response, never from loaded
 * rows, so a period of several thousand payments costs one small read.
 *
 * `GET /merchant-sales/summary?from&to` (#4897; UTC calendar days, inclusive).
 * Pass `null` to skip the read (the Revenue comparison on a period with
 * nothing to compare to, or a page that is not mounted on a Sales account).
 * The state keys on the range, so changing the period shows loading, not the
 * previous period's figures under the new period's label; a superseded answer
 * never writes.
 *
 * #4960: `filters` narrow the summary as they narrow the list (#4959 reads the
 * same filtered relation for both), so the tiles, the chart, the breakdowns
 * and the rows agree for one filter set. The state keys on them too.
 *
 * #5012: `live` re-reads the summary every 10 s while the tab is visible
 * (`useVisiblePolling`), SILENTLY: the figures on screen stay until the new
 * answer replaces them, a failed re-read keeps them, and nothing shows
 * loading. Each read also asks the backend to refresh the account's index
 * (throttled there per account), which is how a payment nobody reported
 * appears while the owner is looking.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { useVisiblePolling } from '@/hooks/useVisiblePolling'
import { NO_SALES_FILTERS, salesFilterQuery, type SalesDayRange, type SalesFilters, type SalesSummary } from '@/lib/sales'

export interface UseSalesSummaryResult {
  data: SalesSummary | null
  loading: boolean
  failed: boolean
  refetch: () => void
}

export function useSalesSummary(
  range: SalesDayRange | null,
  filters: SalesFilters = NO_SALES_FILTERS,
  { live = false }: { live?: boolean } = {},
): UseSalesSummaryResult {
  const [data, setData] = useState<SalesSummary | null>(null)
  const [loading, setLoading] = useState(range !== null)
  const [failed, setFailed] = useState(false)
  const requestIdRef = useRef(0)
  const from = range?.from ?? null
  const to = range?.to ?? null
  const filterQuery = salesFilterQuery(filters)

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current
    if (from === null || to === null) {
      setData(null)
      setLoading(false)
      setFailed(false)
      return
    }
    setLoading(true)
    setFailed(false)
    setData(null)
    try {
      const response = await api.get<SalesSummary>(
        `/merchant-sales/summary?from=${from}&to=${to}${filterQuery ? `&${filterQuery}` : ''}`,
      )
      if (requestIdRef.current !== requestId) return
      setData(response)
    } catch {
      if (requestIdRef.current !== requestId) return
      setFailed(true)
    } finally {
      if (requestIdRef.current === requestId) setLoading(false)
    }
  }, [from, to, filterQuery])

  useEffect(() => {
    void load()
    return () => {
      requestIdRef.current += 1
    }
  }, [load])

  // The silent re-read does not take a request id of its own: it answers for
  // the read in force when it started, and is dropped if the range, the
  // filters or a full load moved on meanwhile.
  const reread = useCallback(async () => {
    if (!live || from === null || to === null) return
    const requestId = requestIdRef.current
    try {
      const response = await api.get<SalesSummary>(
        `/merchant-sales/summary?from=${from}&to=${to}${filterQuery ? `&${filterQuery}` : ''}`,
      )
      if (requestIdRef.current !== requestId) return
      setData(response)
      setFailed(false)
    } catch {
      // Keep the figures on screen; the next tick tries again.
    }
  }, [live, from, to, filterQuery])
  useVisiblePolling(reread)

  return { data, loading, failed, refetch: () => void load() }
}
