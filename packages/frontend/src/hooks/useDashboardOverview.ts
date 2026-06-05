'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import {
  fetchX402ActivityTransactions,
  mergeTransactionsWithX402Activity,
} from '@/lib/x402-activity-transactions'
import type { DashboardOverviewResponse } from '@/types/dashboard'

export function useDashboardOverview() {
  const [data, setData] = useState<DashboardOverviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  const fetchOverview = useCallback(async () => {
    const requestId = ++requestIdRef.current
    try {
      setLoading(true)
      setError(null)
      const response = await api.get<DashboardOverviewResponse>('/dashboard/overview')
      if (requestIdRef.current !== requestId) return

      const x402Transactions = await fetchX402ActivityTransactions()
      if (requestIdRef.current !== requestId) return

      const transactions = mergeTransactionsWithX402Activity(
        response.transactions,
        x402Transactions,
      )

      setData({
        ...response,
        transactions,
      })
    } catch (err) {
      if (requestIdRef.current === requestId) {
        setError(err instanceof Error ? err.message : 'Failed to load dashboard overview')
      }
    } finally {
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

  return {
    data,
    loading,
    error,
    refetch: fetchOverview,
  }
}
