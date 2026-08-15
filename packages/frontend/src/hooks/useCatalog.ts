'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { ApiSchema } from '@haven_ai/core'

/**
 * #1445: was a hand-written copy that had fallen two fields behind the spec —
 * `tool_arguments` (suggested MCP tool arguments for a product variant) and
 * `asset_transfer_methods` were invisible to the UI because the local type
 * never declared them.
 */
export type CatalogEntry = ApiSchema<'CatalogEntry'>

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
