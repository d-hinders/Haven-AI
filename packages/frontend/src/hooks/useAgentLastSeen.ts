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

  const poll = useCallback(async () => {
    if (!agentId || !isMountedRef.current) return

    try {
      const res = await api.get<AgentLastSeenResponse>(`/agents/${agentId}`)
      const ts = res.mcp_last_seen_at ?? null
      if (isMountedRef.current) {
        setLastSeenAt(ts)
      }
      // Schedule next poll — guard required: the component may have unmounted
      // while the fetch was in-flight. Without this check, setTimeout fires
      // after cleanup and creates an infinite polling loop after unmount.
      const delay = ts ? POLL_INTERVAL_CONNECTED : POLL_INTERVAL_WAITING
      if (isMountedRef.current) {
        timerRef.current = setTimeout(poll, delay)
      }
    } catch {
      // Swallow errors — network hiccups shouldn't break the UI.
      // Retry at the waiting interval.
      if (isMountedRef.current) {
        timerRef.current = setTimeout(poll, POLL_INTERVAL_WAITING)
      }
    }
  }, [agentId])

  useEffect(() => {
    isMountedRef.current = true
    setLastSeenAt(null) // Reset when agentId changes

    if (!agentId) return

    // Kick off immediately
    void poll()

    return () => {
      isMountedRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [agentId, poll])

  return { lastSeenAt, isConnected: lastSeenAt !== null }
}
