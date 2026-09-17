'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { TransactionFilterOptionsResponse } from '@/types/transactions'

interface UseTransactionFiltersReturn extends TransactionFilterOptionsResponse {
  loading: boolean
  error: string | null
  refresh: (fresh?: boolean) => Promise<void>
}

export function useTransactionFilters(): UseTransactionFiltersReturn {
  const [accounts, setAccounts] = useState<TransactionFilterOptionsResponse['accounts']>([])
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

      // `?? []` on every key, deliberately. `api.get` does no response
      // validation, so a missing key stores `undefined` and the next render
      // calls `.map`/`.find`/`.length` on it — which takes the whole
      // transactions route down through the shell's ErrorBoundary, not just
      // this bar. That is #1075's failure mode and #2295 repeated it. It is
      // live here because the `accounts` key is NEW in this release: a new
      // bundle briefly talks to a pre-rename backend during the deploy.
      setAccounts(data.accounts ?? [])
      setAgents(data.agents ?? [])
      setTokens(data.tokens ?? [])
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

  const refresh = useCallback(async (fresh = true) => {
    await fetchFilters(fresh)
  }, [fetchFilters])

  return {
    accounts,
    agents,
    tokens,
    loading,
    error,
    refresh,
  }
}
