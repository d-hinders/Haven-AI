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
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { SALES_PAGE_SIZE, type SalesDayRange, type SalesPayment, type SalesPaymentsPage } from '@/lib/sales'

export interface UseSalesPaymentsResult {
  payments: SalesPayment[]
  hasMore: boolean
  loading: boolean
  loadingMore: boolean
  failed: boolean
  loadMore: () => void
  refetch: () => void
}

function pagePath(range: SalesDayRange | null, limit: number, cursor: string | null): string {
  const params = new URLSearchParams()
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
  { limit = SALES_PAGE_SIZE }: { limit?: number } = {},
): UseSalesPaymentsResult {
  const [payments, setPayments] = useState<SalesPayment[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [failed, setFailed] = useState(false)
  const requestIdRef = useRef(0)
  const from = range?.from ?? null
  const to = range?.to ?? null

  const first = useCallback(async () => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    setLoadingMore(false)
    setFailed(false)
    setPayments([])
    setCursor(null)
    try {
      const scope = from !== null && to !== null ? { from, to } : null
      const page = await api.get<SalesPaymentsPage>(pagePath(scope, limit, null))
      if (requestIdRef.current !== requestId) return
      setPayments(page.payments)
      setCursor(page.next_cursor)
    } catch {
      if (requestIdRef.current !== requestId) return
      setFailed(true)
    } finally {
      if (requestIdRef.current === requestId) setLoading(false)
    }
  }, [from, to, limit])

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
      .get<SalesPaymentsPage>(pagePath(scope, limit, cursor))
      .then((page) => {
        if (requestIdRef.current !== requestId) return
        setPayments((current) => [...current, ...page.payments])
        setCursor(page.next_cursor)
      })
      .catch(() => {
        if (requestIdRef.current !== requestId) return
        setFailed(true)
      })
      .finally(() => {
        if (requestIdRef.current === requestId) setLoadingMore(false)
      })
  }, [cursor, loadingMore, from, to, limit])

  return {
    payments,
    hasMore: cursor !== null,
    loading,
    loadingMore,
    failed,
    loadMore,
    refetch: () => void first(),
  }
}
