'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { AgentStatus } from '@/lib/payment-status'

export interface AgentAllowance {
  id: string
  agent_id: string
  token_address: string
  token_symbol: string
  allowance_amount: string
  reset_period_min: number
}

export interface Agent {
  id: string
  name: string
  description: string | null
  delegate_address: string | null
  safe_id: string | null
  safe_address: string | null
  safe_name: string | null
  safe_chain_id?: number | null
  api_key?: string | null
  api_key_prefix?: string | null
  status: AgentStatus
  created_at: string
  allowances: AgentAllowance[]
  /** ISO timestamp of the most recent MCP tool call. Null until first contact. */
  mcp_last_seen_at?: string | null
  /** True when there are open reconciliation events indicating stranded delegate funds. */
  has_stranded_funds?: boolean
}

interface CreateAgentParams {
  name: string
  description?: string
  delegate_address: string
  safe_id?: string
  allowances?: {
    token_address: string
    token_symbol: string
    allowance_amount: string
    reset_period_min: number
  }[]
}

export function useAgents() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchAgents = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await api.get<{ agents: Agent[] }>('/agents')
      setAgents(res.agents)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We could not load connected agents.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchAgents()
  }, [fetchAgents])

  const createAgent = useCallback(
    async (params: CreateAgentParams): Promise<Agent> => {
      const agent = await api.post<Agent>('/agents', params)
      setAgents((prev) => [agent, ...prev])
      return agent
    },
    [],
  )

  const updateAgent = useCallback(
    async (
      id: string,
      params: {
        name?: string
        description?: string
      },
    ): Promise<Agent> => {
      const agent = await api.put<Agent>(`/agents/${id}`, params)
      setAgents((prev) => prev.map((a) => (a.id === id ? agent : a)))
      return agent
    },
    [],
  )

  const deleteAgent = useCallback(async (id: string): Promise<void> => {
    await api.delete(`/agents/${id}`)
    setAgents((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const revokeAgent = useCallback(async (id: string): Promise<void> => {
    await api.post(`/agents/${id}/revoke`, {})
    setAgents((prev) =>
      prev.map((a) => (a.id === id ? { ...a, status: 'revoked' } : a)),
    )
  }, [])

  const pauseAgent = useCallback(async (id: string): Promise<void> => {
    await api.post(`/agents/${id}/pause`, {})
    setAgents((prev) =>
      prev.map((a) => (a.id === id ? { ...a, status: 'paused' } : a)),
    )
  }, [])

  const resumeAgent = useCallback(async (id: string): Promise<void> => {
    await api.post(`/agents/${id}/resume`, {})
    setAgents((prev) =>
      prev.map((a) => (a.id === id ? { ...a, status: 'active' } : a)),
    )
  }, [])

  return {
    agents,
    loading,
    error,
    createAgent,
    updateAgent,
    deleteAgent,
    revokeAgent,
    pauseAgent,
    resumeAgent,
    refetch: fetchAgents,
  }
}
