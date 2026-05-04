'use client'

import { useState, useCallback } from 'react'
import { api } from '@/lib/api'

export interface SelfSignAgentAllowance {
  id: string
  agent_id: string
  token_address: string
  token_symbol: string
  allowance_amount: string
  reset_period_min: number
}

export interface SelfSignAgent {
  id: string
  name: string
  description: string | null
  delegate_address: string
  safe_id: string | null
  safe_address: string | null
  safe_name: string | null
  status: string
  created_at: string
  allowances: SelfSignAgentAllowance[]
  auth_type: 'self_sign'
}

export function useSelfSignAgents() {
  const [agents, setAgents] = useState<SelfSignAgent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchAgents = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.get<{ agents: SelfSignAgent[] }>('/self-sign-agents')
      setAgents(data.agents)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load agents')
    } finally {
      setLoading(false)
    }
  }, [])

  const createAgent = useCallback(
    async (body: {
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
    }) => {
      const agent = await api.post<SelfSignAgent>('/self-sign-agents', body)
      setAgents((prev) => [agent, ...prev])
      return agent
    },
    [],
  )

  const updateAgent = useCallback(
    async (
      id: string,
      body: {
        name?: string
        description?: string
      },
    ) => {
      const updated = await api.put<SelfSignAgent>(`/self-sign-agents/${id}`, body)
      setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, ...updated } : a)))
      return updated
    },
    [],
  )

  const deleteAgent = useCallback(async (id: string) => {
    await api.delete(`/self-sign-agents/${id}`)
    setAgents((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const revokeAgent = useCallback(async (id: string) => {
    await api.post(`/self-sign-agents/${id}/revoke`)
    setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, status: 'revoked' } : a)))
  }, [])

  const upsertAllowance = useCallback(
    async (
      agentId: string,
      body: {
        token_address: string
        token_symbol: string
        allowance_amount: string
        reset_period_min: number
      },
    ) => {
      const allowance = await api.post<SelfSignAgentAllowance>(
        `/self-sign-agents/${agentId}/allowances`,
        body,
      )
      setAgents((prev) =>
        prev.map((a) => {
          if (a.id !== agentId) return a
          const existing = a.allowances.find(
            (al) => al.token_address === allowance.token_address,
          )
          return {
            ...a,
            allowances: existing
              ? a.allowances.map((al) =>
                  al.token_address === allowance.token_address ? allowance : al,
                )
              : [...a.allowances, allowance],
          }
        }),
      )
      return allowance
    },
    [],
  )

  const deleteAllowance = useCallback(async (agentId: string, tokenAddress: string) => {
    await api.delete(`/self-sign-agents/${agentId}/allowances/${tokenAddress}`)
    setAgents((prev) =>
      prev.map((a) =>
        a.id === agentId
          ? { ...a, allowances: a.allowances.filter((al) => al.token_address !== tokenAddress) }
          : a,
      ),
    )
  }, [])

  return {
    agents,
    loading,
    error,
    fetchAgents,
    createAgent,
    updateAgent,
    deleteAgent,
    revokeAgent,
    upsertAllowance,
    deleteAllowance,
  }
}
