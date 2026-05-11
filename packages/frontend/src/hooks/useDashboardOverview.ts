'use client'

import { useCallback, useEffect, useState } from 'react'
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

  const fetchOverview = useCallback(async () => {
    try {
      setError(null)
      const response = await api.get<DashboardOverviewResponse>('/dashboard/overview')
      const x402Transactions = await fetchX402ActivityTransactions()
      const transactions = mergeTransactionsWithX402Activity(
        response.transactions,
        x402Transactions,
      )
      const additionalX402Count = transactions.length - response.transactions.length

      setData({
        ...response,
        transactions,
        metrics: {
          ...response.metrics,
          successfulTransactions:
            response.metrics.successfulTransactions + Math.max(0, additionalX402Count),
        },
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard overview')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchOverview()
  }, [fetchOverview])

  return {
    data,
    loading,
    error,
    refetch: fetchOverview,
  }
}
