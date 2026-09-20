'use client'

import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/context/AuthContext'
import { useAgents, type Agent } from '@/hooks/useAgents'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'

export type AgentBusyAction = 'pause' | 'resume' | 'archive' | 'restore' | null

/**
 * State and async orchestration for the agents panel. All accounts the panel
 * can render are on the delegation rail (#2413 filters the account list to
 * `delegator_hybrid`), and all agent authority actions belong to that rail.
 * The panel deliberately has no on-chain Safe transaction path.
 */
export function useAgentPanelState() {
  const { activeAccount } = useAuth()
  const router = useRouter()
  const accountAddress = activeAccount?.account_address ?? null
  const chainId = activeAccount?.chain_id ?? DEFAULT_CHAIN_ID
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
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<AgentBusyAction>(null)
  const [showRemovedAgents, setShowRemovedAgents] = useState(false)
  const [toastMessage, setToastMessage] = useState<string | null>(null)

  // First-agent hand-off from onboarding. #2413 dropped the rail guard that
  // stopped a legacy account reopening the create flow from a stale URL
  // parameter — no legacy account renders this panel any more.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('setup') !== 'first') return
    setFirstAgentSetup(true)
    setConnectAgentOpen(true)
    params.delete('setup')
    const query = params.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`)
  }, [])

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

  /**
   * #3168: the card's first action navigates to the agent detail page — the
   * surface where the agent's budgets and spending controls live, and which
   * also hosts name/description editing (the detail page's kebab → "Edit
   * agent" modal). What used to be the Edit/Details fork is now this one
   * navigation for every operational card: Edit opened a name/description
   * modal on the list, and nothing about the card needed it once the detail
   * page is the destination. A client-side router push, not a full-page
   * assignment, so the authenticated shell does not remount.
   * `useAgentPanelState` is only mounted inside the app router's tree, so
   * `useRouter` is always defined here.
   */
  function handleViewDetails(agent: Agent) {
    router.push(`/agents/${agent.id}`)
  }

  async function handlePause(agent: Agent) {
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

  return {
    accountAddress,
    chainId,
    activeAccountId: activeAccount?.id,
    agents,
    loading,
    error,
    visibleAgents,
    removedAgents,
    connectAgentOpen,
    setConnectAgentOpen,
    firstAgentSetup,
    handleSetupUpdated,
    finalizingAgent,
    finalizeTimedOut,
    retryFinalizePoll,
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
