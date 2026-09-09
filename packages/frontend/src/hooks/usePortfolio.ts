'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import { useVisiblePolling } from '@/hooks/useVisiblePolling'
import type { PortfolioResponse, PortfolioBreakdown } from '@/types/transactions'

interface UsePortfolioReturn {
  totalUsd: number
  totalEur: number
  breakdown: PortfolioBreakdown[]
  loading: boolean
  error: string | null
  refetch: () => void
}

interface UsePortfolioOptions {
  chainId?: number
}

export function usePortfolio(
  safeAddress: string | null,
  { chainId }: UsePortfolioOptions = {},
): UsePortfolioReturn {
  const [totalUsd, setTotalUsd] = useState(0)
  const [totalEur, setTotalEur] = useState(0)
  const [breakdown, setBreakdown] = useState<PortfolioBreakdown[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const generationRef = useRef(0)

  const fetchPortfolio = useCallback(async (silent = false) => {
    const generation = ++generationRef.current

    if (!safeAddress) {
      setTotalUsd(0)
      setTotalEur(0)
      setBreakdown([])
      setError(null)
      setLoading(false)
      return
    }

    try {
      // #2732: silent visible-poll ticks must not flash the skeleton, and
      // must not clear a visible error banner until they actually succeed.
      if (!silent) {
        setLoading(true)
        setError(null)
      }
      const chainQuery = chainId === undefined ? '' : `?chain_id=${encodeURIComponent(String(chainId))}`
      const data = await api.get<PortfolioResponse>(
        `/portfolio/${safeAddress}${chainQuery}`,
      )
      if (generationRef.current === generation) {
        setTotalUsd(data.totalUsd)
        setTotalEur(data.totalEur)
        setBreakdown(data.breakdown)
        if (silent) setError(null)
      }
    } catch (err) {
      // A failed silent tick keeps the last good totals and any visible
      // error exactly as it was.
      if (generationRef.current === generation && !silent) {
        setError(err instanceof Error ? err.message : 'Failed to load portfolio')
      }
    } finally {
      if (generationRef.current === generation) {
        setLoading(false)
      }
    }
  }, [chainId, safeAddress])

  useEffect(() => {
    if (!safeAddress) {
      generationRef.current += 1
      setLoading(false)
      return
    }

    fetchPortfolio()

    return () => {
      generationRef.current += 1
    }
  }, [fetchPortfolio, safeAddress])

  // #2732: the 60s interval moved into the shared visible-only policy — 10s
  // while visible, immediate fetch on return-to-visible, zero fetches while
  // hidden. Silent ticks never flip `loading` back on.
  useVisiblePolling(() => {
    void fetchPortfolio(true)
  })

  return { totalUsd, totalEur, breakdown, loading, error, refetch: fetchPortfolio }
}
