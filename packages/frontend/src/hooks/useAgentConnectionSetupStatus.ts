'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'

/**
 * A copied setup command normally registers within a few seconds. A FIRST run
 * has to download the connector first, which on a slow network can take a
 * minute or more — so at this bound Haven only acknowledges that it is taking
 * a while. Nothing is wrong yet, and the wording must not suggest otherwise
 * (#1399).
 */
export const AWAITING_CONNECTION_SLOW_MS = 60_000

/**
 * Only here does Haven offer recovery. Deliberately the same 3 minutes as the
 * connector's own `waitForBudgetApproval` bound in `@haven_ai/connect`: by the
 * time this fires the connector has given up and exited, so "run the command
 * again" is sound advice rather than a guess. **If either bound moves, both
 * must** — see `docs/operations/mcp-runtime-compatibility.md`.
 */
export const AWAITING_CONNECTION_RECOVERY_MS = 180_000

/**
 * How long a confirmed `awaiting_connection` has been running, as the waiting
 * screen tells it: reassure, then acknowledge the wait, then offer a way out.
 */
export type AwaitingConnectionStage = 'starting' | 'slow' | 'recovery'

export type AgentConnectionSetupStatus =
  | 'awaiting_connection'
  | 'connected_local'
  | 'awaiting_wallet_approval'
  | 'approval_in_progress'
  | 'proposed'
  | 'active'
  | 'expired'
  | 'cancelled'
  | 'failed'

export interface AgentConnectionSetupStatusResponse {
  setup_id: string
  agent_id: string | null
  status: AgentConnectionSetupStatus
  expires_at: string
  agent: {
    name: string
    description?: string | null
  }
  haven_wallet: {
    id: string
    name: string
    address: string
    chain_id: number
    network: string
  }
  agent_budget: Array<{
    id?: string
    token_address: string
    token_symbol: string
    allowance_amount: string
    reset_period_min: number
  }>
  delegate_address?: string | null
  api_key_prefix?: string | null
  runtime?: string | null
  connector?: {
    connector_version?: string | null
    environment_label?: string
    runtime_version?: string
    config_target?: string
  }
  install_status?: {
    runtime_mcp_mode?: string
    skill_installed?: boolean
    hosted_mcp_configured?: boolean
    local_signer_configured?: boolean
    local_mcp_configured?: boolean
    credential_files_written?: boolean
    signer_acknowledged?: boolean
    local_mcp_acknowledged?: boolean
    activation_command_available?: boolean
    probe_result?: string
    restart_required?: boolean
    next_user_action?: string
    error_code?: string | null
    last_probe_at?: string
  }
  approval?: {
    safe_tx_hash?: string | null
    tx_hash?: string | null
    status?: string | null
  }
  failure_reason?: string | null
}

export function useAgentConnectionSetupStatus(
  setupId: string | null,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const [data, setData] = useState<AgentConnectionSetupStatusResponse | null>(null)
  const [loading, setLoading] = useState(Boolean(setupId && enabled))
  const [error, setError] = useState<string | null>(null)
  const [awaitingConnectionStage, setAwaitingConnectionStage] =
    useState<AwaitingConnectionStage>('starting')
  const generationRef = useRef(0)

  const fetchStatus = useCallback(async () => {
    if (!setupId || !enabled) {
      setLoading(false)
      return null
    }
    const generation = ++generationRef.current
    try {
      setLoading(true)
      setError(null)
      const next = await api.get<AgentConnectionSetupStatusResponse>(
        `/agent-connection-setups/${encodeURIComponent(setupId)}`,
      )
      if (generationRef.current === generation) {
        setData(next)
      }
      return next
    } catch (err) {
      if (generationRef.current === generation) {
        setError(err instanceof Error ? err.message : 'We could not load this agent setup.')
      }
      return null
    } finally {
      if (generationRef.current === generation) {
        setLoading(false)
      }
    }
  }, [enabled, setupId])

  useEffect(() => {
    if (!setupId || !enabled) {
      setData(null)
      setError(null)
      setLoading(false)
      setAwaitingConnectionStage('starting')
      return
    }

    let cancelled = false
    let timeout: number | null = null

    async function tick() {
      const next = await fetchStatus()
      if (cancelled) return
      const status = next?.status
      const shouldPoll =
        status === 'awaiting_connection' ||
        status === 'connected_local' ||
        status === 'awaiting_wallet_approval' ||
        status === 'approval_in_progress' ||
        status === 'proposed'
      if (shouldPoll) {
        const localMcpConfigured = next?.install_status?.local_mcp_configured
        const fastPoll = status === 'awaiting_connection' || (status === 'connected_local' && !localMcpConfigured)
        timeout = window.setTimeout(tick, fastPoll ? 3000 : 10000)
      }
    }

    void tick()
    return () => {
      cancelled = true
      generationRef.current += 1
      if (timeout !== null) window.clearTimeout(timeout)
    }
  }, [enabled, fetchStatus, setupId])

  // Two bounds, one clock. Only a CONFIRMED `awaiting_connection` advances it:
  // a status-read error resets to 'starting' rather than counting toward
  // recovery, because a flaky poll is not evidence about the connector. The
  // effect keys on `data?.status`, not `data`, so ordinary poll ticks do not
  // restart the clock.
  useEffect(() => {
    if (!setupId || !enabled || data?.status !== 'awaiting_connection' || error) {
      setAwaitingConnectionStage('starting')
      return
    }
    const slow = window.setTimeout(
      () => setAwaitingConnectionStage('slow'),
      AWAITING_CONNECTION_SLOW_MS,
    )
    const recovery = window.setTimeout(
      () => setAwaitingConnectionStage('recovery'),
      AWAITING_CONNECTION_RECOVERY_MS,
    )
    return () => {
      window.clearTimeout(slow)
      window.clearTimeout(recovery)
    }
  }, [data?.status, enabled, error, setupId])

  return {
    data,
    loading,
    error,
    awaitingConnectionStage,
    refetch: fetchStatus,
  }
}
