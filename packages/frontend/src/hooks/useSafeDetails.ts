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

interface UseSafeDetailsOptions {
  enabled?: boolean
}

export function useSafeDetails(
  safeAddress: string | null,
  { enabled = true }: UseSafeDetailsOptions = {},
): UseSafeDetailsReturn {
  const [details, setDetails] = useState<SafeDetails | null>(null)
  const [loading, setLoading] = useState(Boolean(safeAddress) && enabled)
  const [error, setError] = useState<string | null>(null)

  const fetchDetails = useCallback(async () => {
    if (!safeAddress || !enabled) {
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
  }, [enabled, safeAddress])

  useEffect(() => {
    if (!safeAddress || !enabled) {
      setLoading(false)
      return
    }

    fetchDetails()
  }, [enabled, fetchDetails, safeAddress])

  return { details, loading, error, refetch: fetchDetails }
}
