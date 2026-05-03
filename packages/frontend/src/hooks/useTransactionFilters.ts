'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { TransactionFilterOptionsResponse } from '@/types/transactions'

interface UseTransactionFiltersReturn extends TransactionFilterOptionsResponse {
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useTransactionFilters(): UseTransactionFiltersReturn {
  const [safes, setSafes] = useState<TransactionFilterOptionsResponse['safes']>([])
  const [agents, setAgents] = useState<TransactionFilterOptionsResponse['agents']>([])
  const [tokens, setTokens] = useState<TransactionFilterOptionsResponse['tokens']>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  const fetchFilters = useCallback(async (fresh = false) => {
    const requestId = ++requestIdRef.current
    setError(null)
    setLoading(true)

    try {
      const data = await api.get<TransactionFilterOptionsResponse>(
        `/transactions/filters${fresh ? '?fresh=1' : ''}`,
      )
      if (requestId !== requestIdRef.current) return

      setSafes(data.safes)
      setAgents(data.agents)
      setTokens(data.tokens)
    } catch (err) {
      if (requestId !== requestIdRef.current) return
      setError(
        err instanceof Error ? err.message : 'Failed to load filters',
      )
    } finally {
      if (requestId !== requestIdRef.current) return
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchFilters(false)
  }, [fetchFilters])

  const refresh = useCallback(async () => {
    await fetchFilters(true)
  }, [fetchFilters])

  return {
    safes,
    agents,
    tokens,
    loading,
    error,
    refresh,
  }
}
