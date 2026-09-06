'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { ApiSchema } from '@haven_ai/core'

/** The funding facts payload — the same object `haven wallets funding` prints. */
export type SafeFunding = ApiSchema<'FundingResponse'>

/**
 * The funding facts for one account (#2534).
 *
 * One read of `GET /user/safes/:safeId/funding`, the endpoint the CLI's
 * `haven wallets funding` reads too, so the dashboard and the terminal hand
 * the human the same numbers from the same place instead of each keeping a
 * copy of a minimum that `@haven_ai/core` owns. The caller decides when it
 * matters: the dashboard fetches only while the account is unfunded (a funded
 * account has no funding instruction to show). `refetch` is exposed so a
 * caller can re-read after an action that could change the answer.
 *
 * Errors are surfaced, not thrown: the checklist step stays usable without
 * the numbers, exactly as the balance read failing keeps the hero usable.
 */
export function useSafeFunding(safeId?: string) {
  const [funding, setFunding] = useState<SafeFunding | null>(null)
  const [loading, setLoading] = useState(Boolean(safeId))
  const [error, setError] = useState<string | null>(null)

  const fetchFunding = useCallback(
    async (options?: { silent?: boolean }): Promise<SafeFunding | null> => {
      if (!safeId) return null
      // `silent` refetches (the tab-visibility poll) skip the loading/error
      // flags so the card does not flicker its skeleton while the user reads it.
      const silent = options?.silent ?? false
      try {
        if (!silent) {
          setLoading(true)
          setError(null)
        }
        const res = await api.get<SafeFunding>(`/user/safes/${safeId}/funding`)
        setFunding(res)
        return res
      } catch (err) {
        if (!silent) {
          setError(err instanceof Error ? err.message : 'Failed to load funding details')
        }
        return null
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [safeId],
  )

  useEffect(() => {
    if (!safeId) return
    void fetchFunding()
  }, [fetchFunding, safeId])

  return { funding, loading, error, refetch: fetchFunding }
}
