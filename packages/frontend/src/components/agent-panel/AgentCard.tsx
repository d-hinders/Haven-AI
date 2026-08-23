'use client'

import { CirclePause, TriangleAlert } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useState, useMemo, type KeyboardEvent, type MouseEvent } from 'react'
import { type Agent } from '@/hooks/useAgents'
import { type AllowanceInfo } from '@/lib/allowance-module'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'
import { formatAgentLastActivity, formatAgentLastActivityTitle } from '@/lib/agent-last-seen'
import ConfirmDialog from '../ConfirmDialog'
import { RemoveAgentDialog } from './RemoveAgentDialog'
import { entityCardClassName } from '../ui/entityCardStyles'
import { AllowanceBar, AllowanceBarSkeleton, ConfiguredAllowanceRow } from './AllowanceBar'
import { BotIcon } from './agent-display'
import type { AgentBusyAction } from '@/hooks/useAgentPanelState'

export function AgentCard({
  agent,
  onChainAllowances,
  onChainLoading,
  chainTimeSec,
  onViewDetails,
  onEdit,
  onPause,
  onResume,
  onRevoke,
  onRevokeCredential,
  onArchive,
  onRestore,
  busyAction,
  canUseWalletActions,
  chainId = DEFAULT_CHAIN_ID,
}: {
  agent: Agent
  onChainAllowances: AllowanceInfo[] | null
  onChainLoading: boolean
  chainTimeSec: number | null
  onViewDetails: (agent: Agent) => void
  onEdit: (agent: Agent) => void
  onPause: (agent: Agent) => void
  onResume: (agent: Agent) => void
  onRevoke: (agent: Agent) => void
  /** RemoveAgentDialog step 2: plain POST /agents/:id/revoke, throws on failure. */
  onRevokeCredential: (agentId: string) => Promise<void>
  /** RemoveAgentDialog step 3: archive (#1401), throws on failure. */
  onArchive: (agent: Agent) => Promise<void>
  onRestore: (agent: Agent) => void
  busyAction: AgentBusyAction
  canUseWalletActions: boolean
  chainId?: number
}) {
  const [pauseModalOpen, setPauseModalOpen] = useState(false)
  const [revokeModalOpen, setRevokeModalOpen] = useState(false)
  const [removeModalOpen, setRemoveModalOpen] = useState(false)

  const isActive = agent.status === 'active'
  const isPaused = agent.status === 'paused'
  const isRevoked = agent.status === 'revoked'
  const isArchived = Boolean(agent.archived_at)
  const isOperational = !isRevoked
  const isDelegationAgent = agent.account_type === 'delegator_hybrid'
  const isBusy = busyAction !== null

  async function handleConfirmPause() {
    setPauseModalOpen(false)
    onPause(agent)
  }

  async function handleConfirmRevoke() {
    setRevokeModalOpen(false)
    onRevoke(agent)
  }

  function openDetails() {
    onViewDetails(agent)
  }

  function handleCardKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openDetails()
    }
  }

  function stopCardClick(event: MouseEvent) {
    event.stopPropagation()
  }

  // Merge on-chain + DB allowance data: on-chain is primary, DB fills gaps
  const displayAllowances = useMemo(() => {
    if (onChainAllowances && onChainAllowances.length > 0) {
      return onChainAllowances
    }
    return null
  }, [onChainAllowances])
  const hasNetworkAllowances = !!displayAllowances && displayAllowances.length > 0
  const hasConfiguredAllowances = agent.allowances.length > 0
  const showConfiguredFallback =
    !onChainLoading &&
    !hasNetworkAllowances &&
    hasConfiguredAllowances

  // Tokens from DB that we haven't seen on-chain yet (shown as skeleton)
  const pendingDbTokens = useMemo(() => {
    if (!onChainLoading) return [] // done loading, trust on-chain
    if (!onChainAllowances) {
      // Still loading — show all DB tokens as skeleton
      return agent.allowances.map((a) => a.token_symbol)
    }
    // Show DB tokens not yet in on-chain results
    const onChainAddrs = new Set(onChainAllowances.map((a) => a.token.toLowerCase()))
    return agent.allowances
      .filter((a) => !onChainAddrs.has(a.token_address.toLowerCase()))
      .map((a) => a.token_symbol)
  }, [onChainAllowances, onChainLoading, agent.allowances])

  return (
    <>
    <div
      role="link"
      tabIndex={0}
      onClick={openDetails}
      onKeyDown={handleCardKeyDown}
      aria-label={`View ${agent.name}`}
      className={`${entityCardClassName({ muted: isRevoked })} cursor-pointer`}
    >
      {/* Header */}
      <div className="flex items-start gap-3 mb-4">
          <div
            className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${
              isActive
                ? 'bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]'
                : isPaused
                  ? 'bg-[var(--v2-warning-soft)] text-[var(--v2-warning)]'
                  : 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-3)]'
            }`}
          >
            <BotIcon size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-[var(--v2-ink)] truncate">
                {agent.name}
              </h3>
              {!isActive ? (
                <span
                  className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                    isPaused
                      ? 'bg-[var(--v2-warning-soft)] text-[var(--v2-warning)]'
                      : agent.status === 'revoked'
                        ? 'bg-[var(--v2-danger-soft)] text-[var(--v2-danger)]'
                        : 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-3)]'
                  }`}
                >
                  {agent.status}
                </span>
              ) : null}
            </div>
            {agent.safe_name && (
              <p className="text-xs text-[var(--v2-ink-2)] mt-0.5">
                <span className="text-[var(--v2-ink-3)]">Account:</span> {agent.safe_name}
              </p>
            )}
            {agent.description && (
              <p className="text-xs text-[var(--v2-ink-3)] mt-0.5">
                {agent.description}
              </p>
            )}
          </div>
          <p
            className="ml-auto shrink-0 pt-0.5 text-right text-xs text-[var(--v2-ink-3)]"
            title={formatAgentLastActivityTitle(agent.mcp_last_seen_at)}
          >
            {formatAgentLastActivity(agent.mcp_last_seen_at)}
          </p>
      </div>

      {isPaused && (
        <div className="mb-3 flex items-start gap-2 px-3 py-2.5 bg-[var(--v2-warning-soft)] border border-warning/20 rounded-lg">
          <Icon icon={CirclePause} className="h-3.5 w-3.5 text-[var(--v2-warning)] flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-medium text-[var(--v2-warning)]">Paused in Haven</p>
            <p className="mt-0.5 text-xs leading-relaxed text-[var(--v2-warning)]">
              New agent payments are blocked until you resume this agent. Existing network permissions stay in place.
            </p>
          </div>
        </div>
      )}

      {agent.has_stranded_funds && (
        <div className="mb-3 flex items-start gap-2 px-3 py-2.5 bg-[var(--v2-warning-soft)] border border-warning/20 rounded-lg">
          <Icon icon={TriangleAlert} className="h-3.5 w-3.5 text-[var(--v2-warning)] flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-[var(--v2-warning)]">Stranded funds on delegate</p>
            <p className="mt-0.5 text-xs leading-relaxed text-[var(--v2-warning)]">
              A payment was funded on-chain but not settled.{' '}
              <a href={`/agents/${agent.id}`} className="underline underline-offset-2">
                View agent to sweep funds back to your account.
              </a>
            </p>
          </div>
        </div>
      )}

      {isOperational && (
        <div className="mb-3">
          <div className="space-y-2">
            <p className="text-xs font-medium text-[var(--v2-ink-3)]">Agent budget</p>

            {hasNetworkAllowances ? (
              displayAllowances.map((info) => (
                <AllowanceBar key={info.token} info={info} chainTimeSec={chainTimeSec} chainId={chainId} />
              ))
            ) : showConfiguredFallback ? (
              agent.allowances.map((allowance) => (
                <ConfiguredAllowanceRow
                  key={allowance.id}
                  allowance={allowance}
                  chainId={chainId}
                />
              ))
            ) : !onChainLoading ? (
              <p className="text-xs text-[var(--v2-ink-3)]">No agent budget configured</p>
            ) : null}

            {pendingDbTokens.map((symbol) => (
              <AllowanceBarSkeleton key={symbol} symbol={symbol} />
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      {/* #1909: `pb-1` is load-bearing, not spacing taste. These controls carry
          `ring-2` with NO offset, so ~2px of every focus ring falls outside the
          control's own box. The clearance the operational branches appeared to
          have was an ACCIDENT of the `|` separators below: they carry no
          `text-xs`, so they inherit 16px/24px and become the tallest flex item,
          and `items-center` then centres the 16px controls inside that 24px band
          — 4px above and below, for free. The archived branch renders no
          separator, so its tallest item IS the 16px control and the row's box
          ended exactly at the control's box: ring flush against the boundary,
          zero clearance, identically on macOS and Linux (measured 29px vs the
          siblings' 37px). Stating the padding makes the clearance a property of
          the row rather than of which children happen to render. 4px is the
          sibling clearance exactly — 2px of ring, 2px clear.

          The result is deliberately asymmetric and that is fine: the branches
          with separators now get ~8px (4 accidental + 4 stated) and the
          archived branch gets 4. Both contain the ring with room to spare, and
          the alternative — a `pb` conditional on which branch rendered — would
          encode the accident instead of retiring it. Giving the separators
          `text-xs` would equalise the band at 16px and make all five branches
          4px, but it also resizes a visible glyph, so it is a design change
          rather than this fix. */}
      <div className="flex items-center gap-2 pt-3 pb-1 border-t border-[var(--v2-border)]" onClick={stopCardClick}>
        {isOperational && (
          <>
            {canUseWalletActions ? (
              <button
                onClick={() => onEdit(agent)}
                disabled={isBusy}
                aria-label={`Edit ${agent.name}`}
                className="text-xs text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors disabled:opacity-50 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
              >
                Edit
              </button>
            ) : (
              <button
                onClick={openDetails}
                disabled={isBusy}
                aria-label={`Open details for ${agent.name}`}
                className="text-xs text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors disabled:opacity-50 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
              >
                Details
              </button>
            )}
            <span className="text-[var(--v2-border-strong)]">|</span>
            {isActive ? (
              <button
                onClick={() => setPauseModalOpen(true)}
                disabled={isBusy}
                aria-label={`Pause ${agent.name}`}
                className="text-xs text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors disabled:opacity-50 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
              >
                {busyAction === 'pause' ? 'Pausing...' : 'Pause'}
              </button>
            ) : (
              <button
                onClick={() => onResume(agent)}
                disabled={isBusy}
                aria-label={`Resume ${agent.name}`}
                className="text-xs text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors disabled:opacity-50 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
              >
                {busyAction === 'resume' ? 'Resuming...' : 'Resume from pause'}
              </button>
            )}
            {/* Safe revoke is an AllowanceModule teardown; on delegation
                agents the whole shutdown is the Remove flow below (#1402),
                so the Safe control is hidden there. */}
            {canUseWalletActions && !isDelegationAgent ? (
              <>
                <span className="text-[var(--v2-border-strong)]">|</span>
                <button
                  onClick={() => setRevokeModalOpen(true)}
                  disabled={isBusy}
                  aria-label={`Revoke ${agent.name}`}
                  className="text-xs text-[var(--v2-ink-3)] hover:text-[var(--v2-danger)] transition-colors disabled:opacity-50 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/80"
                >
                  Revoke
                </button>
              </>
            ) : null}
            {/* #1402: Remove = revoke-all budgets + revoke credential +
                archive, one confirmed action. Delegation agents only while
                operational; on legacy agents Revoke stays the shutdown and
                Remove appears after it (the revoked branch below). */}
            {isDelegationAgent ? (
              <>
                <span className="text-[var(--v2-border-strong)]">|</span>
                <button
                  onClick={() => setRemoveModalOpen(true)}
                  disabled={isBusy}
                  aria-label={`Remove ${agent.name}`}
                  className="text-xs text-[var(--v2-ink-3)] hover:text-[var(--v2-danger)] transition-colors disabled:opacity-50 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/80"
                >
                  Remove
                </button>
              </>
            ) : null}
          </>
        )}
        {isRevoked && !isArchived && (
          <>
            <span className="text-xs text-[var(--v2-ink-3)]">
              Network access already revoked
            </span>
            <span className="text-[var(--v2-border-strong)]">|</span>
            <button
              onClick={() => setRemoveModalOpen(true)}
              disabled={isBusy}
              aria-label={`Remove ${agent.name}`}
              className="text-xs text-[var(--v2-ink-3)] hover:text-[var(--v2-danger)] transition-colors disabled:opacity-50 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/80"
            >
              {busyAction === 'archive' ? 'Removing...' : 'Remove'}
            </button>
          </>
        )}
        {isArchived && (
          <>
            {/* #1909: `whitespace-nowrap` on the action label, with the sentence
                beside it left free to wrap. Under CI's (Linux) font metrics
                `Restore to list` broke across two lines at DESKTOP width — the
                committed baseline was 438x45 where macOS rendered 438x29 — so
                this is a real wrap, not a rendering-judge quirk.

                The 390px budget says this costs nothing. Row content width
                there is 300px (342px card less `p-5` and borders), gap 8px, so
                the two children share 292px. Unwrapped the label is 77px and
                the sentence is 340px — the sentence CANNOT fit on one line at
                this width whatever the label does, and its `min-content` is
                53px. Pinning the label therefore leaves 300 - 77 - 8 - 53 =
                162px of slack before the row could overflow, and the measured
                overflow at 390px is 0. A two-word action label is an atomic
                phrase; the explanatory sentence is the thing that should reflow.

                That budget is ASSERTED rather than merely recorded here — see
                "the archived branch does not overflow at 390px" in
                `e2e/focus-visible.visual.spec.ts`, which checks both the
                overflow and the single line at exactly this width. Arithmetic
                in a comment is run by nobody.

                Rejected: shortening to `Restore` (43px unwrapped) — a shorter
                label is still a wrappable one, so it buys probability where the
                whole lesson of this defect is that macOS metrics mispredicted
                Linux by 16px, and it drops the object from a control whose
                destination is the point (`aria-label` says "to the list").
                Rejected: widening the container — it is the agents grid column,
                so every card on the page moves to fix one label. */}
            <button
              onClick={() => onRestore(agent)}
              disabled={isBusy}
              aria-label={`Restore ${agent.name} to the list`}
              className="text-xs whitespace-nowrap text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors disabled:opacity-50 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
            >
              {busyAction === 'restore' ? 'Restoring...' : 'Restore to list'}
            </button>
            <span className="ml-auto text-xs text-[var(--v2-ink-3)]">
              History stays readable; restoring never re-enables spending
            </span>
          </>
        )}
      </div>
    </div>

    <ConfirmDialog
      open={pauseModalOpen}
      onCancel={() => setPauseModalOpen(false)}
      onConfirm={handleConfirmPause}
      title={`Pause ${agent.name}?`}
      body={
        <div className="space-y-3">
          <p>
            Pausing stops this agent from creating new payments through Haven right away, without changing its network permissions.
          </p>
          <div className="rounded-lg border border-brand/15 bg-[var(--v2-brand-soft)] px-3 py-3 text-[var(--v2-ink-2)]">
            <p className="text-xs font-medium text-[var(--v2-brand)] mb-1">What stays the same</p>
            <p className="text-xs leading-relaxed">
              The agent&apos;s network permissions remain in place. You can resume this agent later without reconnecting or reconfiguring it.
            </p>
          </div>
          <p className="text-xs text-[var(--v2-ink-2)]">
            Use Pause for a fast, reversible stop. Use Revoke when you also want to remove the agent&apos;s network spending authority.
          </p>
        </div>
      }
      confirmLabel="Pause agent"
      tone="primary"
      loading={busyAction === 'pause'}
    />

    <ConfirmDialog
      open={revokeModalOpen}
      onCancel={() => setRevokeModalOpen(false)}
      onConfirm={handleConfirmRevoke}
      title={`Revoke ${agent.name}?`}
      body={
        <div className="space-y-3">
          <p>
            This removes the agent&apos;s Haven access immediately and also revokes its network spending authority.
          </p>
          <div className="rounded-lg border border-danger/15 bg-[var(--v2-danger-soft)] px-3 py-3 text-[var(--v2-ink-2)]">
            <p className="text-xs font-medium text-[var(--v2-danger)] mb-1">What happens next</p>
            <p className="text-xs leading-relaxed">
              Haven will stop accepting new requests from this agent, and you&apos;ll be asked to approve the update that removes its spending access.
            </p>
          </div>
          <p className="text-xs text-[var(--v2-ink-2)]">
            Use Pause when you want a quick, reversible stop. Use Revoke when you want to fully shut this agent down.
          </p>
        </div>
      }
      confirmLabel="Revoke agent"
      loading={busyAction === 'revoke'}
    />

    {/* Mounted only while open: its hooks (budget prepare, delegate-balance
        read) are per-agent and must not run for every card in the list. */}
    {removeModalOpen && (
      <RemoveAgentDialog
        agent={agent}
        chainId={chainId}
        onRevokeCredential={() => onRevokeCredential(agent.id)}
        onArchive={() => onArchive(agent)}
        onClose={() => setRemoveModalOpen(false)}
      />
    )}
    </>
  )
}
