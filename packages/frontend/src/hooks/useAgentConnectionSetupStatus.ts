'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'

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
    hosted_mcp_configured?: boolean
    local_signer_configured?: boolean
    credential_files_written?: boolean
    signer_acknowledged?: boolean
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
        timeout = window.setTimeout(tick, status === 'awaiting_connection' ? 3000 : 10000)
      }
    }

    void tick()
    return () => {
      cancelled = true
      generationRef.current += 1
      if (timeout !== null) window.clearTimeout(timeout)
    }
  }, [enabled, fetchStatus, setupId])

  return {
    data,
    loading,
    error,
    refetch: fetchStatus,
  }
}
