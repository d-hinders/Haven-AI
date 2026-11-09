'use client'

/**
 * The signed-in user's setups that are still awaiting a connector (#4710).
 *
 * The dashboard's "still connecting" row reads this instead of the overview:
 * the overview is about agents and accounts, and a setup has no agent yet.
 * `null` means UNKNOWN (the read has not landed or failed) — the rules layer
 * never fires a row on an unknown read (#3295), so a failed poll shows
 * nothing rather than a stale row.
 *
 * Polling follows the one dashboard policy (`useVisiblePolling`, ~10 s while
 * visible): the row must disappear on its own when the agent registers or the
 * setup is cancelled, and the setup expires within 30 minutes.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiSchema } from '@haven_ai/core'
import { api } from '@/lib/api'
import { useVisiblePolling } from '@/hooks/useVisiblePolling'

export type PendingConnectionSetup = ApiSchema<'PendingAgentConnectionSetup'>
type PendingConnectionSetupsResponse = ApiSchema<'PendingAgentConnectionSetupsResponse'>

export function usePendingConnectionSetups() {
  const [data, setData] = useState<PendingConnectionSetup[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  const fetchPending = useCallback(async (silent = false) => {
    const requestId = ++requestIdRef.current
    try {
      if (!silent) {
        setLoading(true)
        setError(null)
      }
      const response = await api.get<PendingConnectionSetupsResponse>(
        '/agent-connection-setups/pending',
      )
      if (requestIdRef.current !== requestId) return
      setData(response.setups)
      // A silent tick that SUCCEEDS clears a stale error; a failed one never
      // changes visible state.
      if (silent) setError(null)
    } catch (err) {
      if (requestIdRef.current === requestId && !silent) {
        setError(err instanceof Error ? err.message : 'Failed to load unfinished connects')
      }
    } finally {
      if (requestIdRef.current === requestId) setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchPending()
    return () => {
      requestIdRef.current += 1
    }
  }, [fetchPending])

  useVisiblePolling(() => {
    void fetchPending(true)
  })

  return {
    data,
    loading,
    error,
    refetch: fetchPending,
  }
}
