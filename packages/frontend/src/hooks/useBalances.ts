'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { BalancesResponse, BalanceItem } from '@/types/transactions'

interface UseBalancesReturn {
  balances: BalanceItem[]
  loading: boolean
  error: string | null
  refetch: () => void
}

export function useBalances(safeAddress: string | null): UseBalancesReturn {
  const [balances, setBalances] = useState<BalanceItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchBalances = useCallback(async () => {
    if (!safeAddress) {
      setBalances([])
      setError(null)
      setLoading(false)
      return
    }

    try {
      setLoading(true)
      setError(null)
      const data = await api.get<BalancesResponse>(
        `/balances/${safeAddress}`,
      )
      setBalances(data.balances)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load balances')
    } finally {
      setLoading(false)
    }
  }, [safeAddress])

  useEffect(() => {
    fetchBalances()

    if (!safeAddress) return

    // Refresh every 60 seconds
    const interval = setInterval(fetchBalances, 60_000)
    return () => clearInterval(interval)
  }, [fetchBalances, safeAddress])

  return { balances, loading, error, refetch: fetchBalances }
}
