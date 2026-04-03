'use client'

import { useState, useEffect, useCallback } from 'react'
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

export function usePortfolio(safeAddress: string | null): UsePortfolioReturn {
  const [totalUsd, setTotalUsd] = useState(0)
  const [totalEur, setTotalEur] = useState(0)
  const [breakdown, setBreakdown] = useState<PortfolioBreakdown[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchPortfolio = useCallback(async () => {
    if (!safeAddress) return

    try {
      setError(null)
      const data = await api.get<PortfolioResponse>(
        `/portfolio/${safeAddress}`,
      )
      setTotalUsd(data.totalUsd)
      setTotalEur(data.totalEur)
      setBreakdown(data.breakdown)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load portfolio')
    } finally {
      setLoading(false)
    }
  }, [safeAddress])

  useEffect(() => {
    fetchPortfolio()
    const interval = setInterval(fetchPortfolio, 60_000)
    return () => clearInterval(interval)
  }, [fetchPortfolio])

  return { totalUsd, totalEur, breakdown, loading, error, refetch: fetchPortfolio }
}
