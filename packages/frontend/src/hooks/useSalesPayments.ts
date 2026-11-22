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
 *
 * #5012: `live` re-reads every 10 s while the tab is visible
 * (`useVisiblePolling`), silently. When only the first page is loaded the
 * fresh page IS the list. When the owner loaded more, the re-read walks the
 * loaded window from the top, page by page, until it reaches the row that was
 * last on screen (#5038): a fresh page 1 alone would leave a hole when more
 * than a page of payments arrived since the last re-read, and would never show
 * a payment the index added late with an older `block_time`. A failed re-read
 * changes nothing. Each read also asks the backend to refresh the account's
 * index (throttled there per account).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { useVisiblePolling } from '@/hooks/useVisiblePolling'
import {
  NO_SALES_FILTERS,
  SALES_PAGE_SIZE,
  SALES_PAYMENTS_MAX_LIMIT,
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

/**
 * Whether `payment` sorts at or below `last` in the list's order — newest
 * first, keyed on `(block_time, tx_hash)` (`merchant-sales-reads.ts`). The
 * window re-read stops at the first row that is at or below the row that was
 * last on screen: everything above it is the window, and a row that a filter
 * or a record-clear removed leaves the next-older row in its place.
 */
function isAtOrBelow(payment: SalesPayment, last: SalesPayment): boolean {
  if (payment.block_time !== last.block_time) return payment.block_time < last.block_time
  return payment.tx_hash <= last.tx_hash
}

export function useSalesPayments(
  range: SalesDayRange | null,
  {
    limit = SALES_PAGE_SIZE,
    filters = NO_SALES_FILTERS,
    live = false,
  }: { limit?: number; filters?: SalesFilters; live?: boolean } = {},
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

  // Read by the silent re-read, which must not take part in React's update
  // queue to decide whether more than the first page is on screen.
  const shownRef = useRef({ payments, loading, loadingMore })
  useEffect(() => {
    shownRef.current = { payments, loading, loadingMore }
  })

  const reread = useCallback(async () => {
    if (!live) return
    const shown = shownRef.current
    if (shown.loading || shown.loadingMore) return
    const requestId = requestIdRef.current
    const scope = from !== null && to !== null ? { from, to } : null
    try {
      if (shown.payments.length <= limit) {
        // Only the first page is loaded: the fresh page IS the list, and its
        // cursor reaches whatever fell off it.
        const page = await api.get<SalesPaymentsPage>(pagePath(scope, limit, null, filterQuery))
        if (requestIdRef.current !== requestId) return
        setPayments(page.payments)
        setCursor(page.next_cursor)
        setTotal(page.total)
        setUsdcRates(page.usdc_rates ?? null)
        setFailed(false)
        return
      }

      // More than one page is loaded: re-read the whole loaded window from the
      // top, page by page, until the read reaches the row that was last on
      // screen (#5038). Each page asks for at most the backend's cap, so a
      // window of more than 200 rows is read in several requests rather than
      // one the route would reject with a 400.
      const last = shown.payments[shown.payments.length - 1]
      const windowLimit = Math.min(SALES_PAYMENTS_MAX_LIMIT, shown.payments.length)
      const rows: SalesPayment[] = []
      let next: string | null = null
      let lastPage: SalesPaymentsPage | null = null
      do {
        const page: SalesPaymentsPage = await api.get<SalesPaymentsPage>(pagePath(scope, windowLimit, next, filterQuery))
        if (requestIdRef.current !== requestId) return
        rows.push(...page.payments)
        lastPage = page
        next = page.next_cursor
        // An empty page ends the walk: nothing more can be reached from it.
        if (page.payments.length === 0) break
        if (page.payments.some((payment) => isAtOrBelow(payment, last))) break
      } while (next !== null)
      if (lastPage === null) return
      setPayments(rows)
      setCursor(next)
      setTotal(lastPage.total)
      setUsdcRates(lastPage.usdc_rates ?? null)
      setFailed(false)
    } catch {
      // Keep the rows on screen; the next tick tries again.
    }
  }, [live, from, to, limit, filterQuery])
  useVisiblePolling(reread)

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
