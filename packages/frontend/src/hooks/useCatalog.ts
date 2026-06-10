'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'

export interface CatalogEntry {
  id: string
  name: string
  description: string
  category: string
  resource_url: string
  rail: 'x402' | 'mpp'
  protocol: 'http' | 'mcp'
  tool_name: string | null
  price_display: string | null
  price_atomic: string | null
  asset: string | null
  network: string | null
  status: 'active' | 'degraded' | 'delisted'
  verified_at: string | null
}

export function useCatalog() {
  const [entries, setEntries] = useState<CatalogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchCatalog = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await api.get<{ entries: CatalogEntry[] }>('/catalog')
      setEntries(res.entries)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We could not load the catalog.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchCatalog()
  }, [fetchCatalog])

  return { entries, loading, error, refetch: fetchCatalog }
}
