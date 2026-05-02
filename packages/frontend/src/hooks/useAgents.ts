'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'

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
  api_key: string
  status: string
  created_at: string
  allowances: AgentAllowance[]
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

  const fetchAgents = useCallback(async () => {
    try {
      const res = await api.get<{ agents: Agent[] }>('/agents')
      setAgents(res.agents)
    } catch {
      // silently ignore
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

  return {
    agents,
    loading,
    createAgent,
    updateAgent,
    deleteAgent,
    revokeAgent,
    refetch: fetchAgents,
  }
}
