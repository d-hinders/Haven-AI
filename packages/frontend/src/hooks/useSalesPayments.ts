'use client'

/**
 * The Sales payments list for one period, paged (#4900, epic #4885).
 *
 * `GET /merchant-sales/payments?from&to&cursor&limit` answers newest first with
 * a `next_cursor`. The list asks for ONE page on a period and a further page
 * only when the owner presses "Show more", passing exactly the cursor the last
 * page returned — a period of several thousand payments is never loaded whole.
 * A change of period starts the list again; an answer that arrives after the
 * period moved is dropped.
 *
 * `range: null` reads the account's whole history (no `from`/`to`), which is how
 * the page asks, with `limit: 1`, whether the account has ever been paid — the
 * first-run test — without a read of its own endpoint.
 *
 * #4960: `filters` narrow the list (the reads are #4959) and a change of them
 * starts it again, as a change of period does. `total` is the read's count for
 * the filter set, every page included: the list's "{shown} of {total}" and its
 * "Show N more" read it, never the loaded rows.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import {
  NO_SALES_FILTERS,
  SALES_PAGE_SIZE,
  salesFilterQuery,
  type SalesDayRange,
  type SalesFilters,
  type SalesPayment,
  type SalesPaymentsPage,
} from '@/lib/sales'

export interface UseSalesPaymentsResult {
  payments: SalesPayment[]
  hasMore: boolean
  /** The read's count for the period and filter set; null until the first page answers. */
  total: number | null
  /** Today's USDC rate the last page carried (#4963), for rows drawn before the summary answers. */
  usdcRates: SalesPaymentsPage['usdc_rates'] | null
  loading: boolean
  loadingMore: boolean
  failed: boolean
  loadMore: () => void
  refetch: () => void
}

function pagePath(range: SalesDayRange | null, limit: number, cursor: string | null, filterQuery: string): string {
  const params = new URLSearchParams(filterQuery)
  if (range !== null) {
    params.set('from', range.from)
    params.set('to', range.to)
  }
  params.set('limit', String(limit))
  if (cursor !== null) params.set('cursor', cursor)
  return `/merchant-sales/payments?${params.toString()}`
}

export function useSalesPayments(
  range: SalesDayRange | null,
  { limit = SALES_PAGE_SIZE, filters = NO_SALES_FILTERS }: { limit?: number; filters?: SalesFilters } = {},
): UseSalesPaymentsResult {
  const [payments, setPayments] = useState<SalesPayment[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [usdcRates, setUsdcRates] = useState<SalesPaymentsPage['usdc_rates'] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [failed, setFailed] = useState(false)
  const requestIdRef = useRef(0)
  const from = range?.from ?? null
  const to = range?.to ?? null
  const filterQuery = salesFilterQuery(filters)

  const first = useCallback(async () => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    setLoadingMore(false)
    setFailed(false)
    setPayments([])
    setCursor(null)
    setTotal(null)
    try {
      const scope = from !== null && to !== null ? { from, to } : null
      const page = await api.get<SalesPaymentsPage>(pagePath(scope, limit, null, filterQuery))
      if (requestIdRef.current !== requestId) return
      setPayments(page.payments)
      setCursor(page.next_cursor)
      setTotal(page.total)
      setUsdcRates(page.usdc_rates ?? null)
    } catch {
      if (requestIdRef.current !== requestId) return
      setFailed(true)
    } finally {
      if (requestIdRef.current === requestId) setLoading(false)
    }
  }, [from, to, limit, filterQuery])

  useEffect(() => {
    void first()
    return () => {
      requestIdRef.current += 1
    }
  }, [first])

  const loadMore = useCallback(() => {
    if (cursor === null || loadingMore) return
    const requestId = ++requestIdRef.current
    setLoadingMore(true)
    setFailed(false)
    const scope = from !== null && to !== null ? { from, to } : null
    api
      .get<SalesPaymentsPage>(pagePath(scope, limit, cursor, filterQuery))
      .then((page) => {
        if (requestIdRef.current !== requestId) return
        setPayments((current) => [...current, ...page.payments])
        setCursor(page.next_cursor)
        setTotal(page.total)
      })
      .catch(() => {
        if (requestIdRef.current !== requestId) return
        setFailed(true)
      })
      .finally(() => {
        if (requestIdRef.current === requestId) setLoadingMore(false)
      })
  }, [cursor, loadingMore, from, to, limit, filterQuery])

  return {
    payments,
    hasMore: cursor !== null,
    total,
    usdcRates,
    loading,
    loadingMore,
    failed,
    loadMore,
    refetch: () => void first(),
  }
}

/**
 * #4960: the period's payment count with NO filter, for the toolbar's
 * "{shown} of {total}" while a filter is on. One row is asked for and only
 * `total` is kept. `enabled: false` (no filter) reads nothing: the filtered
 * list's own `total` is then the whole period's.
 */
export function useSalesPeriodTotal(range: SalesDayRange, enabled: boolean): number | null {
  const [total, setTotal] = useState<number | null>(null)
  const requestIdRef = useRef(0)
  const { from, to } = range

  useEffect(() => {
    const requestId = ++requestIdRef.current
    setTotal(null)
    if (!enabled) return
    api
      .get<SalesPaymentsPage>(pagePath({ from, to }, 1, null, ''))
      .then((page) => {
        if (requestIdRef.current === requestId) setTotal(page.total)
      })
      .catch(() => {
        // Without it the toolbar shows no count; the rows still load.
      })
    return () => {
      requestIdRef.current += 1
    }
  }, [from, to, enabled])

  return total
}
