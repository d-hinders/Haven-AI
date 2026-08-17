'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { ApiSchema } from '@haven_ai/core'

/**
 * Wire shapes from the generated API types (#1445, epic #1442). These were
 * hand-maintained duplicates of what `openapi/spec.ts` already declares, and
 * they had drifted in both directions:
 *
 *   - `api_key_prefix` and `safe_chain_id` were optional here, though every
 *     read route returns them; the local type made call sites defend against
 *     a case the API does not produce.
 *   - `api_key` was folded into the shared shape even though ONLY the creation
 *     response carries it — hence `CreateAgentResponse` below, which is what
 *     the spec models with `allOf: [Agent, { api_key, passport_requested }]`.
 *   - `has_stranded_funds` and `passport_requested` were returned by the routes
 *     and absent from the spec entirely. Both are documented there now; they
 *     had gone unnoticed because `Agent` sets `additionalProperties: true`, so
 *     nothing in the contract chain was looking (#1444).
 */
export type AgentAllowance = ApiSchema<'AgentAllowance'>
export type Agent = ApiSchema<'Agent'>
export type CreateAgentResponse = ApiSchema<'CreateAgentResponse'>

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

  const fetchAgents = useCallback(
    async (options?: { silent?: boolean }): Promise<Agent[]> => {
      // `silent` refetches (used by the post-setup poll) skip the loading/error
      // flags so the list doesn't flicker its skeleton or surface a transient
      // error every couple of seconds while we wait for a new agent to land.
      const silent = options?.silent ?? false
      try {
        if (!silent) {
          setLoading(true)
          setError(null)
        }
        const res = await api.get<{ agents: Agent[] }>('/agents')
        setAgents(res.agents)
        return res.agents
      } catch (err) {
        if (!silent) {
          setError(err instanceof Error ? err.message : 'We could not load connected agents.')
        }
        return []
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [],
  )

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

  // #1402: removal is an archive (#1401) — the agent leaves the primary list
  // client-side; the row and its history stay readable under Removed.
  const archiveAgent = useCallback(async (id: string): Promise<void> => {
    const res = await api.post<{ archived_at: string }>(`/agents/${id}/archive`, {})
    setAgents((prev) =>
      prev.map((a) => (a.id === id ? { ...a, archived_at: res.archived_at } : a)),
    )
  }, [])

  // Restores nothing but list placement — the agent stays revoked.
  const unarchiveAgent = useCallback(async (id: string): Promise<void> => {
    await api.post(`/agents/${id}/unarchive`, {})
    setAgents((prev) =>
      prev.map((a) => (a.id === id ? { ...a, archived_at: null } : a)),
    )
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
    archiveAgent,
    unarchiveAgent,
    revokeAgent,
    pauseAgent,
    resumeAgent,
    refetch: fetchAgents,
  }
}
