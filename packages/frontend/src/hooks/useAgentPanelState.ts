'use client'

import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '@/context/AuthContext'
import { useAgents, type Agent } from '@/hooks/useAgents'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'

export type AgentBusyAction = 'pause' | 'resume' | 'archive' | 'restore' | null

/**
 * State and async orchestration for the agents panel. Legacy Safe accounts
 * remain readable, but all agent authority actions belong to the delegation
 * rail. The panel deliberately has no on-chain Safe transaction path.
 */
export function useAgentPanelState() {
  const { activeSafe } = useAuth()
  const safeAddress = activeSafe?.safe_address ?? null
  const chainId = activeSafe?.chain_id ?? DEFAULT_CHAIN_ID
  const isDelegationAccount = activeSafe?.account_type === 'delegator_hybrid'
  const {
    agents,
    loading,
    error,
    revokeAgent,
    pauseAgent,
    resumeAgent,
    archiveAgent,
    unarchiveAgent,
    refetch,
  } = useAgents()

  const [connectAgentOpen, setConnectAgentOpen] = useState(false)
  const [firstAgentSetup, setFirstAgentSetup] = useState(false)
  const [finalizingAgent, setFinalizingAgent] = useState(false)
  const [finalizeTimedOut, setFinalizeTimedOut] = useState(false)
  const [editAgent, setEditAgent] = useState<Agent | null>(null)
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<AgentBusyAction>(null)
  const [showRemovedAgents, setShowRemovedAgents] = useState(false)
  const [toastMessage, setToastMessage] = useState<string | null>(null)

  // First-agent hand-off from onboarding. A legacy account must not reopen a
  // create flow from a stale URL parameter.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('setup') !== 'first') return
    if (isDelegationAccount) {
      setFirstAgentSetup(true)
      setConnectAgentOpen(true)
    }
    params.delete('setup')
    const query = params.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`)
  }, [isDelegationAccount])

  const newAgentPollRef = useRef<{ cancelled: boolean } | null>(null)
  const lastPollDelegateRef = useRef<string | null>(null)

  useEffect(() => {
    return () => {
      if (newAgentPollRef.current) newAgentPollRef.current.cancelled = true
      newAgentPollRef.current = null
    }
  }, [])

  const pollForNewAgent = useCallback(
    async (delegateAddress: string | null | undefined) => {
      if (newAgentPollRef.current) newAgentPollRef.current.cancelled = true
      const token = { cancelled: false }
      newAgentPollRef.current = token
      const key = delegateAddress?.toLowerCase()
      if (!key) {
        await refetch({ silent: true })
        return
      }

      lastPollDelegateRef.current = delegateAddress ?? null
      setFinalizingAgent(true)
      setFinalizeTimedOut(false)
      try {
        let latest = (await refetch({ silent: true })) ?? []
        const hasAgent = (list: Agent[]) =>
          list.some(
            (agent) => agent.status !== 'revoked' && agent.delegate_address?.toLowerCase() === key,
          )
        const deadline = Date.now() + 30_000
        while (!token.cancelled && !hasAgent(latest) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 2000))
          if (token.cancelled) return
          latest = (await refetch({ silent: true })) ?? []
        }
        if (!token.cancelled && !hasAgent(latest)) setFinalizeTimedOut(true)
      } finally {
        if (newAgentPollRef.current === token) setFinalizingAgent(false)
      }
    },
    [refetch],
  )

  useEffect(() => {
    if (finalizeTimedOut && agents.length > 0) setFinalizeTimedOut(false)
  }, [agents.length, finalizeTimedOut])

  const visibleAgents = useMemo(() => agents.filter((agent) => !agent.archived_at), [agents])
  const removedAgents = useMemo(() => agents.filter((agent) => Boolean(agent.archived_at)), [agents])

  useEffect(() => {
    if (!toastMessage) return
    const timeout = window.setTimeout(() => setToastMessage(null), 3000)
    return () => window.clearTimeout(timeout)
  }, [toastMessage])

  const agentUsesActiveSafe = useCallback(
    (agent: Agent): boolean => {
      if (agent.safe_id) return agent.safe_id === activeSafe?.id
      if (agent.safe_address) {
        const agentChainId = agent.safe_chain_id ?? DEFAULT_CHAIN_ID
        return Boolean(
          safeAddress &&
            agent.safe_address.toLowerCase() === safeAddress.toLowerCase() &&
            agentChainId === chainId,
        )
      }
      return true
    },
    [activeSafe?.id, chainId, safeAddress],
  )

  function handleViewDetails(agent: Agent) {
    window.location.href = `/agents/${agent.id}`
  }

  function handleEdit(agent: Agent) {
    if (!agentUsesActiveSafe(agent)) {
      handleViewDetails(agent)
      return
    }
    setEditAgent(agent)
  }

  useEffect(() => {
    if (editAgent && !agentUsesActiveSafe(editAgent)) setEditAgent(null)
  }, [agentUsesActiveSafe, editAgent])

  async function handlePause(agent: Agent) {
    if (agent.account_type !== 'delegator_hybrid') return
    setBusyAgentId(agent.id)
    setBusyAction('pause')
    try {
      await pauseAgent(agent.id)
    } catch (err) {
      console.error('Pause failed:', err)
      setToastMessage(err instanceof Error ? err.message : 'Pause failed')
    } finally {
      setBusyAgentId(null)
      setBusyAction(null)
    }
  }

  async function handleResume(agent: Agent) {
    if (agent.account_type !== 'delegator_hybrid') return
    setBusyAgentId(agent.id)
    setBusyAction('resume')
    try {
      await resumeAgent(agent.id)
    } catch (err) {
      console.error('Resume failed:', err)
      setToastMessage(err instanceof Error ? err.message : 'Resume failed')
    } finally {
      setBusyAgentId(null)
      setBusyAction(null)
    }
  }

  async function handleArchive(agent: Agent) {
    setBusyAgentId(agent.id)
    setBusyAction('archive')
    try {
      await archiveAgent(agent.id)
    } finally {
      setBusyAgentId(null)
      setBusyAction(null)
    }
  }

  async function handleRestore(agent: Agent) {
    setBusyAgentId(agent.id)
    setBusyAction('restore')
    try {
      await unarchiveAgent(agent.id)
    } catch {
      setToastMessage('The agent could not be restored to the list')
    } finally {
      setBusyAgentId(null)
      setBusyAction(null)
    }
  }

  function handleSetupUpdated(info?: { delegateAddress?: string | null }) {
    void pollForNewAgent(info?.delegateAddress)
  }

  function retryFinalizePoll() {
    void pollForNewAgent(lastPollDelegateRef.current)
  }

  function handleAgentEdited() {
    void refetch()
    setEditAgent(null)
  }

  return {
    safeAddress,
    chainId,
    activeSafeId: activeSafe?.id,
    isDelegationAccount,
    agents,
    loading,
    error,
    visibleAgents,
    removedAgents,
    agentUsesActiveSafe,
    connectAgentOpen,
    setConnectAgentOpen,
    firstAgentSetup,
    handleSetupUpdated,
    finalizingAgent,
    finalizeTimedOut,
    retryFinalizePoll,
    editAgent,
    setEditAgent,
    handleEdit,
    handleAgentEdited,
    busyAgentId,
    busyAction,
    handleViewDetails,
    handlePause,
    handleResume,
    handleArchive,
    handleRestore,
    revokeAgentCredential: revokeAgent,
    showRemovedAgents,
    setShowRemovedAgents,
    toastMessage,
    refetchAgents: refetch,
  }
}

export type AgentPanelState = ReturnType<typeof useAgentPanelState>
