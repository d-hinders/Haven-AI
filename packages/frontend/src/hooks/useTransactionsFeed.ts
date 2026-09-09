'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { useVisiblePolling } from '@/hooks/useVisiblePolling'
import type {
  AggregatedTransaction,
  TransactionFilterState,
  TransactionsFeedResponse,
} from '@/types/transactions'

interface UseTransactionsFeedReturn {
  transactions: AggregatedTransaction[]
  total: number
  loadingInitial: boolean
  loadingMore: boolean
  refreshing: boolean
  hasMore: boolean
  error: string | null
  partialFailure: boolean
  failedSafeIds: string[]
  loadMore: () => Promise<void>
  refresh: () => Promise<void>
}

function toQueryString(
  filters: TransactionFilterState,
  offset: number,
  limit: number,
  fresh = false,
): string {
  const params = new URLSearchParams()
  if (filters.safeId) params.set('safeId', filters.safeId)
  if (filters.agentId) params.set('agentId', filters.agentId)
  if (filters.tokenKey) params.set('tokenKey', filters.tokenKey)
  params.set('offset', String(offset))
  params.set('limit', String(limit))
  if (fresh) params.set('fresh', '1')
  return params.toString()
}

function transactionIdentityKey(tx: AggregatedTransaction): string {
  return [
    tx.chainId,
    tx.safeId,
    tx.hash.toLowerCase(),
    tx.type,
    tx.from.toLowerCase(),
    tx.to.toLowerCase(),
    tx.value,
    tx.tokenAddress?.toLowerCase() ?? 'native',
  ].join(':')
}

function appendUniqueTransactions(
  existing: AggregatedTransaction[],
  next: AggregatedTransaction[],
): AggregatedTransaction[] {
  const seen = new Set(existing.map(transactionIdentityKey))
  const merged = [...existing]
  for (const tx of next) {
    const key = transactionIdentityKey(tx)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(tx)
  }
  return merged
}

export function useTransactionsFeed(
  filters: TransactionFilterState,
  limit = 25,
): UseTransactionsFeedReturn {
  const [transactions, setTransactions] = useState<AggregatedTransaction[]>([])
  const [total, setTotal] = useState(0)
  const [loadingInitial, setLoadingInitial] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [partialFailure, setPartialFailure] = useState(false)
  const [failedSafeIds, setFailedSafeIds] = useState<string[]>([])

  const requestIdRef = useRef(0)
  const filtersRef = useRef(filters)
  const transactionsRef = useRef<AggregatedTransaction[]>([])
  filtersRef.current = filters
  transactionsRef.current = transactions

  const fetchPage = useCallback(
    async (
      offset: number,
      append: boolean,
      fresh: boolean,
      opts: { silent?: boolean; limitOverride?: number } = {},
    ) => {
      const requestId = ++requestIdRef.current
      const filtersForRequest = filtersRef.current
      // #2732: a silent poll refetches the window the user has actually
      // loaded (page 0 through the loaded count) instead of resetting to the
      // first page — resetting would collapse pagination and scroll depth
      // every 10 seconds. With nothing loaded yet the override is 0 and the
      // tick falls back to the normal page size.
      const override = opts.limitOverride ?? 0
      const effectiveLimit = override > 0 ? override : limit
      const silent = opts.silent ?? false

      if (!silent) setError(null)
      if (append) {
        setLoadingMore(true)
      } else if (silent) {
        // Silent: no refreshing/initial flag — the AC forbids a spinner.
      } else if (fresh || transactionsRef.current.length > 0) {
        setRefreshing(true)
      } else {
        setLoadingInitial(true)
      }

      try {
        const data = await api.get<TransactionsFeedResponse>(
          `/transactions?${toQueryString(filtersForRequest, offset, effectiveLimit, fresh)}`,
        )
        if (requestId !== requestIdRef.current) return

        setTransactions((prev) =>
          append
            ? appendUniqueTransactions(prev, data.transactions)
            : data.transactions,
        )
        setTotal(data.total)
        setHasMore(data.hasMore)
        setPartialFailure(data.partialFailure)
        setFailedSafeIds(data.failedSafeIds)
        if (silent) setError(null)
      } catch (err) {
        if (requestId !== requestIdRef.current) return
        // #2732: a FAILED silent tick changes no visible state — the list
        // keeps its last good rows instead of being emptied mid-demo.
        if (silent) return

        setError(
          err instanceof Error ? err.message : 'Failed to load transactions',
        )
        if (!append) {
          setTransactions([])
          setTotal(0)
          setHasMore(false)
          setPartialFailure(false)
          setFailedSafeIds([])
        }
      } finally {
        if (requestId !== requestIdRef.current) return

        setLoadingInitial(false)
        setLoadingMore(false)
        setRefreshing(false)
      }
    },
    [limit],
  )

  useEffect(() => {
    setTransactions([])
    setTotal(0)
    setHasMore(false)
    setPartialFailure(false)
    setFailedSafeIds([])
    setLoadingInitial(true)
    setError(null)
    void fetchPage(0, false, false)
  }, [fetchPage, filters.safeId, filters.agentId, filters.tokenKey])

  const loadMore = useCallback(async () => {
    if (loadingInitial || loadingMore || refreshing || !hasMore) return
    await fetchPage(transactionsRef.current.length, true, false)
  }, [fetchPage, hasMore, loadingInitial, loadingMore, refreshing])

  const refresh = useCallback(async () => {
    await fetchPage(0, false, true)
  }, [fetchPage])

  // #2732 visible-only polling: silent, fresh (backend cache bypass), and
  // scoped to the window the user has loaded so pagination survives the tick.
  useVisiblePolling(() => {
    void fetchPage(0, false, true, {
      silent: true,
      limitOverride: transactionsRef.current.length,
    })
  })

  return {
    transactions,
    total,
    loadingInitial,
    loadingMore,
    refreshing,
    hasMore,
    error,
    partialFailure,
    failedSafeIds,
    loadMore,
    refresh,
  }
}
