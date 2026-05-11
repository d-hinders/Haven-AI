'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import {
  fetchX402ActivityTransactions,
  mergeTransactionsWithX402Activity,
} from '@/lib/x402-activity-transactions'
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
    async (offset: number, append: boolean, fresh: boolean) => {
      const requestId = ++requestIdRef.current

      setError(null)
      if (append) {
        setLoadingMore(true)
      } else if (fresh || transactionsRef.current.length > 0) {
        setRefreshing(true)
      } else {
        setLoadingInitial(true)
      }

      try {
        const data = await api.get<TransactionsFeedResponse>(
          `/transactions?${toQueryString(filtersRef.current, offset, limit, fresh)}`,
        )
        const x402Transactions = offset === 0
          ? await fetchX402ActivityTransactions(filtersRef.current)
          : []

        if (requestId !== requestIdRef.current) return

        const pageTransactions = offset === 0
          ? mergeTransactionsWithX402Activity(data.transactions, x402Transactions)
          : data.transactions

        setTransactions((prev) =>
          append
            ? mergeTransactionsWithX402Activity(prev, pageTransactions)
            : pageTransactions,
        )
        setTotal(data.total)
        setHasMore(data.hasMore)
        setPartialFailure(data.partialFailure)
        setFailedSafeIds(data.failedSafeIds)
      } catch (err) {
        if (requestId !== requestIdRef.current) return

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
