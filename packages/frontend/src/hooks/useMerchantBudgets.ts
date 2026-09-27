'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiRequestError } from '@/lib/api'
import type { ApiOperations } from '@haven_ai/core'

/**
 * `GET /merchants/{slug}/budgets` wire shape (#3331): every ACTIVE, unexpired
 * merchant-locked budget the owner issued for this merchant, on an agent that
 * is not revoked. Dashboard session only — an agent key gets 403. There is no
 * named component schema for one row (it is declared inline on the
 * operation), so the row type is read off the generated operation rather than
 * duplicated by hand.
 */
export type MerchantBudget =
  ApiOperations['listMerchantBudgets']['responses']['200']['content']['application/json']['budgets'][number]

/**
 * The merchant page's "remaining this period" read (#3331). Distinct from
 * `useDelegationBudget` (agent-scoped, dashboard AND agent-key callers): this
 * is merchant-scoped and dashboard-only, so it is its own hook rather than a
 * parameterisation of that one.
 */
export function useMerchantBudgets(slug: string, { enabled = true }: { enabled?: boolean } = {}) {
  const [budgets, setBudgets] = useState<MerchantBudget[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const generation = useRef(0)

  const reload = useCallback(async () => {
    if (!enabled) return
    const mine = ++generation.current
    try {
      setLoading(true)
      setError(null)
      setForbidden(false)
      const res = await api.get<{ budgets: MerchantBudget[] }>(`/merchants/${slug}/budgets`)
      if (mine !== generation.current) return
      // `?? []` — an absent key must degrade, not crash the route (#3093).
      setBudgets(res.budgets ?? [])
    } catch (err) {
      if (mine !== generation.current) return
      if (err instanceof ApiRequestError && err.status === 403) {
        // An agent-key caller: nothing here belongs to it, and this is not a
        // page a credential-less or agent-authenticated reader ever sees —
        // absorb it as "nothing to show" rather than an error banner.
        setForbidden(true)
        setBudgets([])
        return
      }
      setBudgets(null)
      setError(err instanceof Error ? err.message : 'We could not load merchant-locked budgets.')
    } finally {
      if (mine === generation.current) setLoading(false)
    }
  }, [slug, enabled])

  useEffect(() => {
    if (!enabled) {
      setBudgets(null)
      setLoading(false)
      setError(null)
      setForbidden(false)
      return
    }
    void reload()
  }, [enabled, reload])

  return { budgets, loading, error, forbidden, refetch: reload }
}
