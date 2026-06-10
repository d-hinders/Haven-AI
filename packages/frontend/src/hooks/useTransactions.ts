'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import type { TransactionsResponse, Transaction } from '@/types/transactions'

interface UseTransactionsReturn {
  transactions: Transaction[]
  loading: boolean
  error: string | null
  page: number
  pages: number
  total: number
  setPage: (page: number) => void
  refetch: () => void
}

interface UseTransactionsOptions {
  limit?: number
  chainId?: number
}

export function useTransactions(
  safeAddress: string | null,
  limitOrOptions: number | UseTransactionsOptions = 10,
): UseTransactionsReturn {
  const limit = typeof limitOrOptions === 'number'
    ? limitOrOptions
    : limitOrOptions.limit ?? 10
  const chainId = typeof limitOrOptions === 'number'
    ? undefined
    : limitOrOptions.chainId
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(0)
  const [total, setTotal] = useState(0)
  const requestIdRef = useRef(0)

  const fetchTransactions = useCallback(async () => {
    const requestId = ++requestIdRef.current
    if (!safeAddress) {
      setTransactions([])
      setPages(0)
      setTotal(0)
      setError(null)
      setLoading(false)
      return
    }

    try {
      setLoading(true)
      setError(null)
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      })
      if (chainId !== undefined) {
        params.set('chain_id', String(chainId))
      }
      const data = await api.get<TransactionsResponse>(
        `/transactions/${safeAddress}?${params.toString()}`,
      )
      if (requestIdRef.current !== requestId) return
      setTransactions(data.transactions)
      setPages(data.pages)
      setTotal(data.total)
    } catch (err) {
      if (requestIdRef.current === requestId) {
        setError(
          err instanceof Error ? err.message : 'Failed to load transactions',
        )
      }
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false)
      }
    }
  }, [safeAddress, page, limit, chainId])

  useEffect(() => {
    fetchTransactions()
    return () => {
      requestIdRef.current += 1
    }
  }, [fetchTransactions])

  return {
    transactions,
    loading,
    error,
    page,
    pages,
    total,
    setPage,
    refetch: fetchTransactions,
  }
}
