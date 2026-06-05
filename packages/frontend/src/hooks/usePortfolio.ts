'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/lib/api'
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

  const fetchPortfolio = useCallback(async () => {
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
      setLoading(true)
      setError(null)
      const chainQuery = chainId === undefined ? '' : `?chain_id=${encodeURIComponent(String(chainId))}`
      const data = await api.get<PortfolioResponse>(
        `/portfolio/${safeAddress}${chainQuery}`,
      )
      if (generationRef.current === generation) {
        setTotalUsd(data.totalUsd)
        setTotalEur(data.totalEur)
        setBreakdown(data.breakdown)
      }
    } catch (err) {
      if (generationRef.current === generation) {
        setError(err instanceof Error ? err.message : 'Failed to load portfolio')
      }
    } finally {
      if (generationRef.current === generation) {
        setLoading(false)
      }
    }
  }, [chainId, safeAddress])

  useEffect(() => {
    fetchPortfolio()
    const interval = setInterval(fetchPortfolio, 60_000)
    return () => {
      generationRef.current += 1
      clearInterval(interval)
    }
  }, [fetchPortfolio])

  return { totalUsd, totalEur, breakdown, loading, error, refetch: fetchPortfolio }
}
