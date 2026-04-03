'use client'

import { useState, useEffect, useCallback } from 'react'
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

export function useTransactions(
  safeAddress: string | null,
  limit = 10,
): UseTransactionsReturn {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(0)
  const [total, setTotal] = useState(0)

  const fetchTransactions = useCallback(async () => {
    if (!safeAddress) return

    try {
      setLoading(true)
      setError(null)
      const data = await api.get<TransactionsResponse>(
        `/transactions/${safeAddress}?page=${page}&limit=${limit}`,
      )
      setTransactions(data.transactions)
      setPages(data.pages)
      setTotal(data.total)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load transactions',
      )
    } finally {
      setLoading(false)
    }
  }, [safeAddress, page, limit])

  useEffect(() => {
    fetchTransactions()
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
