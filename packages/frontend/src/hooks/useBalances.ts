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

interface UseBalancesOptions {
  enabled?: boolean
}

export function useBalances(
  safeAddress: string | null,
  { enabled = true }: UseBalancesOptions = {},
): UseBalancesReturn {
  const [balances, setBalances] = useState<BalanceItem[]>([])
  const [loading, setLoading] = useState(Boolean(safeAddress) && enabled)
  const [error, setError] = useState<string | null>(null)

  const fetchBalances = useCallback(async () => {
    if (!safeAddress) {
      setBalances([])
      setError(null)
      setLoading(false)
      return
    }

    if (!enabled) {
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
  }, [enabled, safeAddress])

  useEffect(() => {
    if (!safeAddress) {
      setBalances([])
      setError(null)
      setLoading(false)
      return
    }

    if (!enabled) {
      setLoading(false)
      return
    }

    fetchBalances()

    // Refresh every 60 seconds
    const interval = setInterval(fetchBalances, 60_000)
    return () => clearInterval(interval)
  }, [enabled, fetchBalances, safeAddress])

  return { balances, loading, error, refetch: fetchBalances }
}
