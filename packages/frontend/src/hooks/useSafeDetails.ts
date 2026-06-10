'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
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
  chainId?: number
}

export function useSafeDetails(
  safeAddress: string | null,
  { enabled = true, chainId }: UseSafeDetailsOptions = {},
): UseSafeDetailsReturn {
  const [details, setDetails] = useState<SafeDetails | null>(null)
  const [loading, setLoading] = useState(Boolean(safeAddress) && enabled)
  const [error, setError] = useState<string | null>(null)
  const generationRef = useRef(0)

  const fetchDetails = useCallback(async () => {
    const generation = ++generationRef.current

    if (!safeAddress) {
      setDetails(null)
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
      const data = await api.get<SafeDetails>(`/safe/${safeAddress}/details${chainQuery}`)
      if (generationRef.current === generation) {
        setDetails(data)
      }
    } catch (err) {
      if (generationRef.current === generation) {
        setError(err instanceof Error ? err.message : 'Failed to load Safe details')
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
      setDetails(null)
      setError(null)
      setLoading(false)
      return
    }

    if (!enabled) {
      generationRef.current += 1
      setLoading(false)
      return
    }

    fetchDetails()
    return () => {
      generationRef.current += 1
    }
  }, [enabled, fetchDetails, safeAddress])

  return { details, loading, error, refetch: fetchDetails }
}
