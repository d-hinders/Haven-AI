'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'

export interface AgentPassport {
  status: 'pending' | 'anchored' | 'failed'
  assurance_level: number
  attestation_uid: string | null
  tx_hash: string | null
  chain_id: number
  attempts: number
  last_error: string | null
  requested_at: string
  anchored_at: string | null
}

export type PassportStandingValue = 'active' | 'suspended' | 'revoked' | 'unknown'
export type PassportAnchorState = 'not_anchored' | 'anchored' | 'revocation_pending' | 'revoked_onchain'

export interface AgentPassportStanding {
  agentId: string
  standing: PassportStandingValue
  anchor: PassportAnchorState
  attestationUid: string | null
  chainLagging: boolean
  revocationConfirmedAt: string | null
}

interface AgentPassportResponse {
  passport: AgentPassport | null
  standing: AgentPassportStanding | null
}

export interface UseAgentPassportResult {
  passport: AgentPassport | null
  standing: AgentPassportStanding | null
  loading: boolean
  /**
   * The lookup itself failed (network/5xx) — NOT the same as "no passport".
   * The card must render a retryable error, never the authoritative empty
   * state, or a transient outage reads as "Not issued" with a live Issue
   * button (review finding on #1112).
   */
  loadError: boolean
  issuing: boolean
  issueError: string | null
  issuePassport: () => Promise<void>
  refetch: () => Promise<void>
}

const EMPTY: AgentPassportResponse = { passport: null, standing: null }

/**
 * Live passport state for one agent (#1072) — `GET /agents/:id/passport`,
 * dashboard-authenticated. `passport: null` is the normal case (issuance is
 * opt-in); `standing`/`anchor` are the two-layer truth the caller must render
 * honestly rather than collapse into one badge (see revocation.ts).
 */
export function useAgentPassport(agentId: string | null): UseAgentPassportResult {
  const [data, setData] = useState<AgentPassportResponse>(EMPTY)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [issuing, setIssuing] = useState(false)
  const [issueError, setIssueError] = useState<string | null>(null)
  // Guards issuePassport's own refetch against a stale write if `agentId`
  // changes while the POST/refetch round-trip is in flight (the mount effect
  // below has its own local `ignore` flag for the same reason).
  const agentIdRef = useRef(agentId)
  useEffect(() => {
    agentIdRef.current = agentId
  }, [agentId])

  const fetchData = useCallback(async () => {
    if (!agentId) return
    setLoading(true)
    try {
      const res = await api.get<AgentPassportResponse>(`/agents/${agentId}/passport`)
      if (agentIdRef.current === agentId) {
        setData({ passport: res.passport ?? null, standing: res.standing ?? null })
        setLoadError(false)
      }
    } catch {
      // Keep whatever we last knew rather than overwriting with EMPTY — the
      // error flag is what the card renders on.
      if (agentIdRef.current === agentId) setLoadError(true)
    } finally {
      if (agentIdRef.current === agentId) setLoading(false)
    }
  }, [agentId])

  useEffect(() => {
    if (!agentId) {
      setData(EMPTY)
      setLoadError(false)
      return
    }
    // Clear immediately so a stale passport from the previous agent can't
    // briefly render during client-side navigation.
    setData(EMPTY)
    setLoadError(false)
    setLoading(true)
    let ignore = false
    api
      .get<AgentPassportResponse>(`/agents/${agentId}/passport`)
      .then((res) => {
        if (!ignore) {
          setData({ passport: res.passport ?? null, standing: res.standing ?? null })
          setLoadError(false)
        }
      })
      .catch(() => {
        if (!ignore) setLoadError(true)
      })
      .finally(() => {
        if (!ignore) setLoading(false)
      })
    return () => {
      // Ignore a late response from a superseded agentId.
      ignore = true
    }
  }, [agentId])

  const issuePassport = useCallback(async () => {
    if (!agentId) return
    setIssuing(true)
    setIssueError(null)
    try {
      await api.post<{ passport: AgentPassport | null; already_issued?: boolean }>(
        `/agents/${agentId}/passport`,
      )
      await fetchData()
    } catch (err) {
      setIssueError(err instanceof Error ? err.message : 'Could not issue a passport.')
    } finally {
      setIssuing(false)
    }
  }, [agentId, fetchData])

  return {
    passport: data.passport,
    standing: data.standing,
    loading,
    loadError,
    issuing,
    issueError,
    issuePassport,
    refetch: fetchData,
  }
}
