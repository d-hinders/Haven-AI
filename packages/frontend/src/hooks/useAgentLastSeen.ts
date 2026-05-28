'use client'

/**
 * useAgentLastSeen — polls GET /agents/:id every few seconds to surface
 * the `mcp_last_seen_at` timestamp produced by the backend's tool-invocation
 * audit log (#185 / #189).
 *
 * Strategy:
 *  - While `lastSeenAt === null`: poll every 3 s (waiting for first contact).
 *  - Once connected: poll every 10 s (keeping the "X ago" label fresh).
 *  - Stops when `agentId` is null / undefined.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'

interface AgentLastSeenResponse {
  mcp_last_seen_at?: string | null
}

/** Time in ms between polls while waiting for first contact. */
const POLL_INTERVAL_WAITING = 3_000
/** Time in ms between polls once the agent has connected. */
const POLL_INTERVAL_CONNECTED = 10_000

export interface UseAgentLastSeenResult {
  /** ISO timestamp of the most recent MCP tool call, or null if never connected. */
  lastSeenAt: string | null
  /** True once `lastSeenAt` is non-null. */
  isConnected: boolean
}

export function useAgentLastSeen(agentId: string | null | undefined): UseAgentLastSeenResult {
  const [lastSeenAt, setLastSeenAt] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isMountedRef = useRef(true)
  // Generation counter: incremented each time the effect re-runs (agentId change
  // or unmount+remount). An in-flight fetch from the *previous* cycle captures its
  // generation at call time; if the ref has advanced by the time the fetch resolves,
  // the response belongs to a stale cycle and is discarded — preventing dual-polling
  // and stale-agent data being written into state for the new agentId.
  const genRef = useRef(0)

  const poll = useCallback(
    async (gen: number) => {
      if (!agentId || !isMountedRef.current || gen !== genRef.current) return

      try {
        const res = await api.get<AgentLastSeenResponse>(`/agents/${agentId}`)
        // Re-check generation and mount status after the async fetch completes.
        if (!isMountedRef.current || gen !== genRef.current) return
        const ts = res.mcp_last_seen_at ?? null
        setLastSeenAt(ts)
        // Schedule next poll — guard required: the component may have unmounted
        // while the fetch was in-flight. Without this check, setTimeout fires
        // after cleanup and creates an infinite polling loop after unmount.
        const delay = ts ? POLL_INTERVAL_CONNECTED : POLL_INTERVAL_WAITING
        timerRef.current = setTimeout(() => void poll(gen), delay)
      } catch {
        // Swallow errors — network hiccups shouldn't break the UI.
        // Retry at the waiting interval.
        if (isMountedRef.current && gen === genRef.current) {
          timerRef.current = setTimeout(() => void poll(gen), POLL_INTERVAL_WAITING)
        }
      }
    },
    [agentId],
  )

  useEffect(() => {
    isMountedRef.current = true
    genRef.current += 1 // Invalidate any in-flight fetch from the previous cycle.
    const gen = genRef.current
    setLastSeenAt(null) // Reset when agentId changes

    if (!agentId) return

    // Kick off immediately
    void poll(gen)

    return () => {
      isMountedRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [agentId, poll])

  return { lastSeenAt, isConnected: lastSeenAt !== null }
}
