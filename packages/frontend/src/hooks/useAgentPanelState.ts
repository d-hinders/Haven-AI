'use client'

import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { usePublicClient } from 'wagmi'
import { type Address } from 'viem'
import { useAuth } from '@/context/AuthContext'
import { useAgents, type Agent } from '@/hooks/useAgents'
import { useOnChainAllowances } from '@/hooks/useOnChainAllowances'
import { useSafeDetails } from '@/hooks/useSafeDetails'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'
import { isUserRejectedError, revokeAgentOnChain } from '@/lib/revoke-agent'
import { isSafeCapableSigner, useActiveSigner } from '@/lib/signer'

export type AgentBusyAction = 'pause' | 'resume' | 'revoke' | 'delete' | null

/**
 * State machine + async orchestration for the agents panel (#989).
 *
 * Everything AgentPanel decides lives here — the post-approval poll, the
 * unmanaged-delegate suppression window, wallet-scoped action gating, and the
 * pause/resume/revoke/delete flows — so it is testable without rendering the
 * panel. AgentPanel itself is composition/layout only.
 */
export function useAgentPanelState() {
  const { activeSafe } = useAuth()
  const safeAddress = activeSafe?.safe_address ?? null
  const chainId = activeSafe?.chain_id ?? DEFAULT_CHAIN_ID
  const { details: safeDetails } = useSafeDetails(safeAddress, { chainId })
  const {
    agents,
    loading,
    revokeAgent,
    pauseAgent,
    resumeAgent,
    deleteAgent,
    refetch,
  } = useAgents()
  const publicClient = usePublicClient({ chainId })
  const activeSigner = useActiveSigner({
    safeAddress: safeAddress ? (safeAddress as Address) : undefined,
    chainId,
  })
  // #1079: this surface signs SAFE transactions; a delegator_passkey cannot.
  // The narrowed view keeps every downstream call type-honest — on delegation
  // accounts these controls are hidden, so null here renders the same
  // no-signer state as before.
  const signer = isSafeCapableSigner(activeSigner) ? activeSigner : null

  const [connect2Open, setConnect2Open] = useState(false)
  const [firstAgentSetup, setFirstAgentSetup] = useState(false)
  // True while the post-approval poll waits for a freshly-signed agent to flip
  // active — drives the "finalizing" placeholder. See `pollForNewAgent`.
  const [finalizingAgent, setFinalizingAgent] = useState(false)
  // True when the poll exhausted its deadline without the agent appearing —
  // drives the "taking longer than expected" fallback so the user isn't left
  // staring at a bare empty state with no explanation. See `pollForNewAgent`.
  const [finalizeTimedOut, setFinalizeTimedOut] = useState(false)
  const [editAgent, setEditAgent] = useState<Agent | null>(null)
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<AgentBusyAction>(null)
  const [showRevokedAgents, setShowRevokedAgents] = useState(false)
  const [toastMessage, setToastMessage] = useState<string | null>(null)

  // First-agent hand-off from onboarding: /agents?setup=first auto-opens the
  // connect flow with a starter allowance prefilled. The param is consumed
  // once and stripped from the URL so refresh/back doesn't re-trigger it.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('setup') !== 'first') return
    setFirstAgentSetup(true)
    setConnect2Open(true)
    params.delete('setup')
    const query = params.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`)
  }, [])

  // Timers for deferred on-chain refetch after agent create/edit. Tracked in a
  // ref so they can be cancelled on unmount, preventing spurious API calls and
  // setState on an unmounted component when the user navigates away within 2s.
  const onChainRefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Cancellation token for the post-setup poll (see `pollForNewAgent`). Held in
  // a ref so an in-flight poll is cancelled on unmount or when superseded.
  const newAgentPollRef = useRef<{ cancelled: boolean } | null>(null)
  // Delegate of the most recent poll, so the timeout fallback's "Check again"
  // can re-poll the same agent without needing the user to redo setup.
  const lastPollDelegateRef = useRef<string | null>(null)
  // Delegates the user set up through Haven this session. If the backend is slow
  // enough that one reappears on-chain before its agent flips active, this lets
  // us label it "finishing setup" rather than "unmanaged / set up outside Haven".
  const havenSetupDelegatesRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    return () => {
      if (onChainRefetchTimerRef.current !== null) clearTimeout(onChainRefetchTimerRef.current)
      if (newAgentPollRef.current) newAgentPollRef.current.cancelled = true
      // Null the ref so a still-resolving poll's `finally` guard
      // (`newAgentPollRef.current === token`) fails and skips setState on the
      // unmounted component.
      newAgentPollRef.current = null
    }
  }, [])

  // Delegates the user just approved in-modal. The on-chain allowance lands a
  // moment before the backend status flips `pending_approval` → `active` and
  // the `/agents` GET filter starts returning the agent. During that window
  // the agent's delegate is on-chain but absent from `agents`, so the
  // unmanagedDelegates classifier would tag it as "Unmanaged Delegate /
  // network only" until the next refresh. We suppress the classification
  // for up to 30s (or until `agents` catches up).
  const [recentDelegates, setRecentDelegates] = useState<Set<string>>(new Set())
  const recentDelegateTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  useEffect(() => {
    const timers = recentDelegateTimersRef.current
    return () => {
      timers.forEach((timer) => clearTimeout(timer))
      timers.clear()
    }
  }, [])
  const markDelegateRecent = useCallback((address: string | null | undefined) => {
    if (!address) return
    const key = address.toLowerCase()
    setRecentDelegates((prev) => {
      if (prev.has(key)) return prev
      const next = new Set(prev)
      next.add(key)
      return next
    })
    const timers = recentDelegateTimersRef.current
    const existing = timers.get(key)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      timers.delete(key)
      setRecentDelegates((prev) => {
        if (!prev.has(key)) return prev
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }, 30_000)
    timers.set(key, timer)
  }, [])
  // After the user signs an agent's rules, the on-chain allowance lands a moment
  // before the backend flips the agent `pending_approval` → `active` and the
  // `/agents` GET starts returning it. A single refetch races that flip and
  // usually loses, leaving the new agent invisible until a manual reload. Poll
  // `/agents` silently until the delegate shows up (or the same 30s window the
  // delegate suppression uses) so the agent appears on its own — no reload, and
  // never a pending-looking row. While we wait, `finalizingAgent` surfaces a
  // placeholder in place of the empty state so the first-agent setup doesn't
  // look like nothing happened.
  const pollForNewAgent = useCallback(
    async (delegateAddress: string | null | undefined) => {
      // Supersede any in-flight poll from an earlier setup.
      if (newAgentPollRef.current) newAgentPollRef.current.cancelled = true
      const token = { cancelled: false }
      newAgentPollRef.current = token

      const key = delegateAddress?.toLowerCase()
      // Without a delegate (setup created/cancelled, manual fallback) there's
      // nothing specific to wait for — a single refresh is all we can do, and
      // we never show the "finalizing" placeholder.
      if (!key) {
        await refetch({ silent: true })
        return
      }
      lastPollDelegateRef.current = delegateAddress ?? null
      havenSetupDelegatesRef.current.add(key)
      setFinalizingAgent(true)
      setFinalizeTimedOut(false)
      try {
        let latest = (await refetch({ silent: true })) ?? []
        const hasAgent = (list: Agent[]) =>
          list.some(
            (agent) =>
              agent.status !== 'revoked' && agent.delegate_address?.toLowerCase() === key,
          )
        const deadline = Date.now() + 30_000
        while (!token.cancelled && !hasAgent(latest) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 2000))
          if (token.cancelled) return
          latest = (await refetch({ silent: true })) ?? []
        }
        // Exhausted the window without the agent landing (not cancelled/found):
        // surface the fallback so the user knows it may still be confirming.
        if (!token.cancelled && !hasAgent(latest)) {
          setFinalizeTimedOut(true)
        }
      } finally {
        // Only the current poll clears the flag — a superseding poll has already
        // re-armed it for the agent it's now waiting on.
        if (newAgentPollRef.current === token) setFinalizingAgent(false)
      }
    },
    [refetch],
  )
  // Clear a stale timeout fallback once any agent is present — e.g. the agent
  // landed on a later refresh, or another agent was added in the meantime.
  useEffect(() => {
    if (finalizeTimedOut && agents.length > 0) setFinalizeTimedOut(false)
  }, [agents.length, finalizeTimedOut])
  const visibleAgents = useMemo(
    () => agents.filter((agent) => agent.status !== 'revoked'),
    [agents],
  )
  const revokedAgents = useMemo(
    () => agents.filter((agent) => agent.status === 'revoked'),
    [agents],
  )

  useEffect(() => {
    if (!toastMessage) return
    const timeout = window.setTimeout(() => setToastMessage(null), 3000)
    return () => window.clearTimeout(timeout)
  }, [toastMessage])

  const agentUsesActiveSafe = useCallback((agent: Agent): boolean => {
    if (agent.safe_id) {
      return agent.safe_id === activeSafe?.id
    }

    if (agent.safe_address) {
      const agentChainId = agent.safe_chain_id ?? DEFAULT_CHAIN_ID
      return Boolean(
        safeAddress &&
          agent.safe_address.toLowerCase() === safeAddress.toLowerCase() &&
          agentChainId === chainId,
      )
    }

    return true
  }, [activeSafe?.id, chainId, safeAddress])

  // Collect managed delegate addresses from DB agents
  const managedDelegates = useMemo(
    () =>
      agents
        .filter((a) => a.status !== 'revoked' && a.delegate_address && agentUsesActiveSafe(a))
        .map((a) => a.delegate_address!),
    [agentUsesActiveSafe, agents],
  )

  // On-chain allowance data — discovers ALL delegates, not just DB agents
  const {
    data: onChainData,
    chainTimeSec,
    loading: onChainLoading,
    onChainDelegates,
    refetch: refetchOnChain,
  } = useOnChainAllowances(safeAddress, managedDelegates, chainId)

  // Find delegates that exist on-chain but not in Haven DB. `recentDelegates`
  // suppresses the brief flicker right after a Connect-agent approval lands
  // on-chain: the delegate is visible on-chain ~immediately, but the
  // `/agents` GET still filters out `pending_approval` agents until the
  // backend records the wallet approval. Without suppression, the new agent
  // shows up as "Unmanaged Delegate / network only" until the next refresh.
  const unmanagedDelegates = useMemo(() => {
    const managedSet = new Set(managedDelegates.map((a) => a.toLowerCase()))
    return onChainDelegates
      .filter((d) => !managedSet.has(d.toLowerCase()))
      .filter((d) => !recentDelegates.has(d.toLowerCase()))
      .map((d) => ({
        address: d,
        allowances: onChainData.get(d.toLowerCase())?.allowances ?? [],
      }))
      .filter((d) => d.allowances.length > 0) // only show if they have allowances
  }, [onChainDelegates, managedDelegates, onChainData, recentDelegates])

  // Drop the suppression early once the agents list catches up — keeps the
  // 30s timer as a fallback for slow backends but cleans up immediately
  // when the agent flips to `active` and reappears in `/agents`.
  useEffect(() => {
    if (recentDelegates.size === 0) return
    const managed = new Set(managedDelegates.map((a) => a.toLowerCase()))
    const matched: string[] = []
    recentDelegates.forEach((addr) => {
      if (managed.has(addr)) matched.push(addr)
    })
    if (matched.length === 0) return
    const timers = recentDelegateTimersRef.current
    matched.forEach((addr) => {
      const timer = timers.get(addr)
      if (timer) clearTimeout(timer)
      timers.delete(addr)
    })
    setRecentDelegates((prev) => {
      const next = new Set(prev)
      matched.forEach((addr) => next.delete(addr))
      return next
    })
  }, [managedDelegates, recentDelegates])

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
    if (editAgent && !agentUsesActiveSafe(editAgent)) {
      setEditAgent(null)
    }
  }, [agentUsesActiveSafe, editAgent])

  // ── Revoke handler ─────────────────────────────────────

  async function handleRevoke(agent: Agent) {
    if (!agentUsesActiveSafe(agent)) {
      setToastMessage('Open this agent to manage its budget from the correct Haven wallet.')
      return
    }
    if (
      !publicClient ||
      !signer ||
      !safeAddress ||
      !safeDetails
    )
      return

    setBusyAgentId(agent.id)
    setBusyAction('revoke')
    try {
      await revokeAgentOnChain({
        agent,
        publicClient,
        signer,
        safeAddress: safeAddress as Address,
        safeDetails,
        chainId,
      })
      await revokeAgent(agent.id)
      await refetchOnChain()
    } catch (err) {
      if (!isUserRejectedError(err)) {
        console.error('Revoke failed:', err)
        setToastMessage(err instanceof Error ? err.message : 'Revoke failed')
      }
    } finally {
      setBusyAgentId(null)
      setBusyAction(null)
    }
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

  async function handleDelete(agent: Agent) {
    setBusyAgentId(agent.id)
    setBusyAction('delete')
    try {
      await deleteAgent(agent.id)
    } catch (err) {
      console.error('Delete failed:', err)
      setToastMessage(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setBusyAgentId(null)
      setBusyAction(null)
    }
  }

  /** ConnectAgent2Modal's onSetupUpdated — suppress the "Unmanaged Delegate"
   *  race window, then poll until the new agent lands (see comments above). */
  function handleSetupUpdated(info?: { delegateAddress?: string | null }) {
    markDelegateRecent(info?.delegateAddress)
    void pollForNewAgent(info?.delegateAddress)
  }

  /** "Check again" on the timeout fallback — re-polls the last setup's
   *  delegate without the user having to redo setup. */
  function retryFinalizePoll() {
    void pollForNewAgent(lastPollDelegateRef.current)
  }

  /** True when a delegate was set up through Haven in this session but its
   *  agent hasn't flipped active yet — mid-setup, not "unmanaged". */
  function isPendingHavenSetup(address: string): boolean {
    return havenSetupDelegatesRef.current.has(address.toLowerCase())
  }

  /** EditAgentModal's onUpdated — refresh, close, and re-read the on-chain
   *  allowances once the update has had time to land. */
  function handleAgentEdited() {
    refetch()
    setEditAgent(null)
    if (onChainRefetchTimerRef.current !== null) clearTimeout(onChainRefetchTimerRef.current)
    onChainRefetchTimerRef.current = setTimeout(refetchOnChain, 2000)
  }

  return {
    // Wallet context
    safeAddress,
    chainId,
    activeSafeId: activeSafe?.id,
    safeDetails,
    // Agents
    agents,
    loading,
    visibleAgents,
    revokedAgents,
    agentUsesActiveSafe,
    // On-chain allowance data
    onChainData,
    chainTimeSec,
    onChainLoading,
    unmanagedDelegates,
    isPendingHavenSetup,
    // Connect flow
    connect2Open,
    setConnect2Open,
    firstAgentSetup,
    handleSetupUpdated,
    // Post-approval poll
    finalizingAgent,
    finalizeTimedOut,
    retryFinalizePoll,
    // Edit flow
    editAgent,
    setEditAgent,
    handleEdit,
    handleAgentEdited,
    // Card actions
    busyAgentId,
    busyAction,
    handleViewDetails,
    handlePause,
    handleResume,
    handleRevoke,
    handleDelete,
    // Revoked disclosure + toast
    showRevokedAgents,
    setShowRevokedAgents,
    toastMessage,
  }
}

export type AgentPanelState = ReturnType<typeof useAgentPanelState>
