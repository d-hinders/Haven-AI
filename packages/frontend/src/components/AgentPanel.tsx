'use client'

import { ChevronRight, CircleAlert, Clock, LoaderCircle, Plus } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useAgentPanelState } from '@/hooks/useAgentPanelState'
import ConnectAgentModal from './ConnectAgentModal'
import EditAgentModal from './EditAgentModal'
import { AgentCard } from './agent-panel/AgentCard'
import { BotIcon } from './agent-panel/agent-display'
import { UnmanagedDelegateCard } from './agent-panel/UnmanagedDelegateCard'
import { Button } from './ui/Button'
import { EmptyState } from './ui/EmptyState'
import { Skeleton } from './ui/Skeleton'

/**
 * The agents panel's shell: header, list layout, empty states, and modals.
 *
 * All state and orchestration live in `useAgentPanelState` (#989) so the flow
 * logic is testable without rendering the panel; the card pieces live in
 * `./agent-panel/`.
 */
export default function AgentPanel() {
  const panel = useAgentPanelState()
  const {
    safeAddress,
    chainId,
    agents,
    loading,
    visibleAgents,
    removedAgents,
    unmanagedDelegates,
    finalizingAgent,
    finalizeTimedOut,
  } = panel

  if (!safeAddress) {
    return (
      <EmptyState
        icon={<BotIcon size={24} />}
        title="Create a Haven account to manage agents"
        body="Agents need a Haven account before they can receive a credential and rules."
      />
    )
  }

  return (
    <div>
      {panel.toastMessage && (
        <div className="fixed right-4 top-4 z-[250] pointer-events-none">
          <div className="rounded-lg border border-[var(--v2-danger)]/20 bg-white px-4 py-3 shadow-[var(--v2-shadow-modal)]">
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 rounded-full bg-[var(--v2-danger-soft)] text-[var(--v2-danger)] flex items-center justify-center flex-shrink-0">
                <Icon icon={CircleAlert} className="h-3 w-3" />
              </div>
              <p className="text-sm font-medium text-[var(--v2-ink)]">{panel.toastMessage}</p>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-1">
          <div className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--v2-surface-2)] text-[var(--v2-ink)]">
            Agents
            <span className="ml-1 text-[var(--v2-ink-3)]">
              {visibleAgents.length}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => panel.setConnectAgentOpen(true)}
            size="sm"
          >
            <Icon icon={Plus} className="h-3.5 w-3.5" />
            Connect agent
          </Button>
        </div>
      </div>

      {/* Agents view */}
      {loading && agents.length === 0 && (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="bg-white border border-[var(--v2-border)] rounded-[10px] p-5"
            >
              <div className="flex items-center gap-3 mb-4">
                <Skeleton className="w-9 h-9 rounded-xl" />
                <div className="space-y-2">
                  <Skeleton variant="text" className="h-3 w-32" />
                  <Skeleton variant="text" className="h-2 w-48" />
                </div>
              </div>
              <Skeleton variant="text" className="h-2 w-full" />
            </div>
          ))}
        </div>
      )}

      {/* Finalizing placeholder — shown while the post-approval poll waits for a
          freshly-signed agent to flip active, so the empty state doesn't flash
          back as if nothing happened. `finalizingAgent` is set for every setup,
          but this only renders when the list is empty (first agent); for
          subsequent agents the existing list stays visible and the new one just
          appends. */}
      {!loading && agents.length === 0 && unmanagedDelegates.length === 0 && finalizingAgent && (
        <EmptyState
          tone="neutral"
          icon={
            /* Heavier stroke: matches the original spinner's 3px ring weight. */
            <Icon icon={LoaderCircle} className="h-[18px] w-[18px] animate-spin" strokeWidth={3} />
          }
          title="Finalizing your agent…"
          body="Haven is confirming the new rules on-chain. Your agent will appear here in a moment — no need to refresh."
        />
      )}

      {/* Timeout fallback — the poll exhausted its window without the agent
          appearing. Rather than dropping silently to the empty state, tell the
          user it may still be confirming and let them re-check. */}
      {!loading &&
        agents.length === 0 &&
        unmanagedDelegates.length === 0 &&
        !finalizingAgent &&
        finalizeTimedOut && (
          <EmptyState
            tone="warning"
            icon={
              <Icon icon={Clock} className="h-[22px] w-[22px]" />
            }
            title="Your agent is taking longer than expected"
            body="Haven is still confirming the new rules on-chain. This can take a little longer under load — check again in a moment."
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button onClick={panel.retryFinalizePoll}>
                  Check again
                </Button>
              </div>
            }
          />
        )}

      {/* Empty state */}
      {!loading &&
        agents.length === 0 &&
        unmanagedDelegates.length === 0 &&
        !finalizingAgent &&
        !finalizeTimedOut && (
        <EmptyState
          icon={<BotIcon size={24} />}
          title="No agents yet"
          body="Set agent rules, then add your Haven credential to your agent so it can make payments within those rules."
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button onClick={() => panel.setConnectAgentOpen(true)}>
                Connect agent
              </Button>
            </div>
          }
        />
      )}

      {/* Agent list */}
      {(agents.length > 0 || unmanagedDelegates.length > 0) && (
        <div className="space-y-4">
          {/* Managed agents */}
          {visibleAgents.length > 0 && (
            <div className="grid items-start gap-4 lg:grid-cols-2">
              {visibleAgents.map((agent) => {
                const delegateKey = agent.delegate_address?.toLowerCase() ?? ''
                const usesActiveSafe = panel.agentUsesActiveSafe(agent)
                const chainData = delegateKey && usesActiveSafe
                  ? panel.onChainData.get(delegateKey)?.allowances ?? null
                  : null
                const agentChainId = agent.safe_chain_id ?? chainId

                return (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    onChainAllowances={chainData}
                    onChainLoading={usesActiveSafe ? panel.onChainLoading : false}
                    chainTimeSec={panel.chainTimeSec}
                    onViewDetails={panel.handleViewDetails}
                    onEdit={panel.handleEdit}
                    onPause={panel.handlePause}
                    onResume={panel.handleResume}
                    onRevoke={panel.handleRevoke}
                    onRevokeCredential={panel.revokeAgentCredential}
                    onArchive={panel.handleArchive}
                    onRestore={panel.handleRestore}
                    busyAction={panel.busyAgentId === agent.id ? panel.busyAction : null}
                    canUseWalletActions={usesActiveSafe}
                    chainId={agentChainId}
                  />
                )
              })}
            </div>
          )}

          {/* #1402: Removed = ARCHIVED agents (archived_at set). History
              stays readable; Restore returns list placement only. */}
          {removedAgents.length > 0 && (
            <div className="pt-1">
              <button
                onClick={() => panel.setShowRemovedAgents((prev) => !prev)}
                className="inline-flex items-center gap-2 text-xs text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)] transition-colors"
              >
                <Icon
                  icon={ChevronRight}
                  className={`h-3 w-3 transition-transform ${panel.showRemovedAgents ? 'rotate-90' : ''}`}
                />
                Removed
                <span className="text-[var(--v2-ink-3)] v2-tabular">({removedAgents.length})</span>
              </button>
            </div>
          )}

          {panel.showRemovedAgents && (
            <div className="grid items-start gap-4 lg:grid-cols-2">
              {removedAgents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  onChainAllowances={null}
                  onChainLoading={false}
                  chainTimeSec={panel.chainTimeSec}
                  onViewDetails={panel.handleViewDetails}
                  onEdit={panel.handleEdit}
                  onPause={panel.handlePause}
                  onResume={panel.handleResume}
                  onRevoke={panel.handleRevoke}
                  onRevokeCredential={panel.revokeAgentCredential}
                  onArchive={panel.handleArchive}
                  onRestore={panel.handleRestore}
                  busyAction={panel.busyAgentId === agent.id ? panel.busyAction : null}
                  canUseWalletActions={panel.agentUsesActiveSafe(agent)}
                  chainId={agent.safe_chain_id ?? chainId}
                />
              ))}
            </div>
          )}

          {/* Unmanaged network delegates */}
          {unmanagedDelegates.map((d) => (
            <UnmanagedDelegateCard
              key={d.address}
              delegate={d.address}
              allowances={d.allowances}
              chainTimeSec={panel.chainTimeSec}
              chainId={chainId}
              pendingHavenSetup={panel.isPendingHavenSetup(d.address)}
            />
          ))}
        </div>
      )}

      <ConnectAgentModal
        open={panel.connectAgentOpen}
        onClose={() => panel.setConnectAgentOpen(false)}
        starterAllowance={panel.firstAgentSetup}
        safeAddress={safeAddress}
        safeId={panel.activeSafeId}
        onSetupUpdated={panel.handleSetupUpdated}
      />

      {/* Edit agent modal */}
      {panel.editAgent && panel.agentUsesActiveSafe(panel.editAgent) && (
        <EditAgentModal
          open={!!panel.editAgent}
          onClose={() => panel.setEditAgent(null)}
          agent={panel.editAgent}
          safeAddress={safeAddress}
          chainId={chainId}
          safeDetails={panel.safeDetails}
          existingOnChainAllowances={
            panel.onChainData.get(panel.editAgent.delegate_address?.toLowerCase() ?? '')?.allowances ?? null
          }
          onUpdated={panel.handleAgentEdited}
        />
      )}
    </div>
  )
}
