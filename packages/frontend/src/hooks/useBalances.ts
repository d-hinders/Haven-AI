'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import { useVisiblePolling } from '@/hooks/useVisiblePolling'
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

  const fetchBalances = useCallback(async (silent = false) => {
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
      // #2732: silent visible-poll ticks must not flash the skeleton, and
      // must not clear a visible error banner until they actually succeed —
      // a failed tick changes no visible state at all.
      if (!silent) {
        setLoading(true)
        setError(null)
      }
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
        if (silent) setError(null)
      }
    } catch (err) {
      // A failed silent tick keeps the last good balances and any visible
      // error exactly as it was.
      if (generationRef.current === generation && !silent) {
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

    return () => {
      generationRef.current += 1
    }
  }, [enabled, fetchBalances, safeAddress])

  // #2732: the 60s interval moved into the shared visible-only policy — 10s
  // while visible, immediate fetch on return-to-visible, zero fetches while
  // hidden. Silent ticks never flip `loading` back on.
  useVisiblePolling(() => {
    void fetchBalances(true)
  })

  return { balances, loading, error, refetch: fetchBalances }
}
