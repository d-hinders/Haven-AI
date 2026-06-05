'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
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
  chainId?: number
}

export function useBalances(
  safeAddress: string | null,
  { enabled = true, chainId }: UseBalancesOptions = {},
): UseBalancesReturn {
  const [balances, setBalances] = useState<BalanceItem[]>([])
  const [loading, setLoading] = useState(Boolean(safeAddress) && enabled)
  const [error, setError] = useState<string | null>(null)
  const generationRef = useRef(0)

  const fetchBalances = useCallback(async () => {
    const generation = ++generationRef.current

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
      const chainQuery = chainId === undefined ? '' : `?chain_id=${encodeURIComponent(String(chainId))}`
      const data = await api.get<BalancesResponse>(
        `/balances/${safeAddress}${chainQuery}`,
      )
      if (generationRef.current === generation) {
        setBalances(
          chainId === undefined
            ? data.balances
            : data.balances.map((balance) => ({ ...balance, chainId })),
        )
      }
    } catch (err) {
      if (generationRef.current === generation) {
        setError(err instanceof Error ? err.message : 'Failed to load balances')
      }
    } finally {
      if (generationRef.current === generation) {
        setLoading(false)
      }
    }
  }, [chainId, enabled, safeAddress])

  useEffect(() => {
    if (!safeAddress) {
      generationRef.current += 1
      setBalances([])
      setError(null)
      setLoading(false)
      return
    }

    if (!enabled) {
      generationRef.current += 1
      setLoading(false)
      return
    }

    fetchBalances()

    // Refresh every 60 seconds
    const interval = setInterval(fetchBalances, 60_000)
    return () => {
      generationRef.current += 1
      clearInterval(interval)
    }
  }, [enabled, fetchBalances, safeAddress])

  return { balances, loading, error, refetch: fetchBalances }
}
