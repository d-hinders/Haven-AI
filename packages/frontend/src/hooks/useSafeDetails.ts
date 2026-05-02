'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { SafeDetails } from '@/types/transactions'

interface UseSafeDetailsReturn {
  details: SafeDetails | null
  loading: boolean
  error: string | null
  refetch: () => void
}

export function useSafeDetails(safeAddress: string | null): UseSafeDetailsReturn {
  const [details, setDetails] = useState<SafeDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchDetails = useCallback(async () => {
    if (!safeAddress) {
      setDetails(null)
      setError(null)
      setLoading(false)
      return
    }

    try {
      setLoading(true)
      setError(null)
      const data = await api.get<SafeDetails>(`/safe/${safeAddress}/details`)
      setDetails(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Safe details')
    } finally {
      setLoading(false)
    }
  }, [safeAddress])

  useEffect(() => {
    fetchDetails()
  }, [fetchDetails, safeAddress])

  return { details, loading, error, refetch: fetchDetails }
}
