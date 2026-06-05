'use client'

import { useState, useMemo, useEffect, useCallback, type KeyboardEvent, type MouseEvent } from 'react'
import { usePublicClient } from 'wagmi'
import { type Address } from 'viem'
import { useAuth } from '@/context/AuthContext'
import { useAgents, type Agent, type AgentAllowance } from '@/hooks/useAgents'
import { useOnChainAllowances } from '@/hooks/useOnChainAllowances'
import { useSafeDetails } from '@/hooks/useSafeDetails'
import {
  computeEffectiveAllowance,
  RESET_PERIODS,
  type AllowanceInfo,
} from '@/lib/allowance-module'
import { getChainTokens } from '@/lib/safe-tx'
import CreateAgentModal from './CreateAgentModal'
import ConnectAgent2Modal from './ConnectAgent2Modal'
import EditAgentModal from './EditAgentModal'
import ConfirmDialog from './ConfirmDialog'
import { truncate } from '@/lib/format'
import { isUserRejectedError, revokeAgentOnChain } from '@/lib/revoke-agent'
import { useActiveSigner } from '@/lib/signer'
import { formatAllowanceAmount, getTokenDecimals } from '@/lib/allowance-format'
import { formatAgentLastActivity, formatAgentLastActivityTitle } from '@/lib/agent-last-seen'
import { Button } from './ui/Button'
import { EmptyState } from './ui/EmptyState'
import { entityCardClassName } from './ui/entityCardStyles'
import { Skeleton } from './ui/Skeleton'

// ── Helpers ────────────────────────────────────────────────────────

function resetLabel(mins: number) {
  return RESET_PERIODS.find((p) => p.value === mins)?.label ?? `${mins}m`
}

function budgetPeriodLabel(mins: number) {
  const label = resetLabel(mins).toLowerCase()
  if (label === 'one-time') return 'total budget'
  if (label === 'daily') return 'per day'
  if (label === 'weekly') return 'per week'
  if (label === 'monthly') return 'per month'
  return `every ${label}`
}

function connectAgent2Enabled(): boolean {
  // Opt-out: ConnectAgent2 is on by default unless explicitly disabled.
  return !['false', '0', 'off'].includes(String(process.env.NEXT_PUBLIC_CONNECT_AGENT_2_ENABLED ?? '').toLowerCase())
}

/** Resolve token address to symbol (chain-aware) */
function tokenSymbol(addr: string, chainId: number): string {
  const lower = addr.toLowerCase()
  const tokens = getChainTokens(chainId)
  if (lower === '0x0000000000000000000000000000000000000000') {
    return Object.entries(tokens).find(([, cfg]) => cfg.address === null)?.[0] ?? 'Native'
  }
  for (const [symbol, cfg] of Object.entries(tokens)) {
    if (cfg.address && cfg.address.toLowerCase() === lower) return symbol
  }
  return truncate(addr)
}

/** Resolve token address to decimals (chain-aware) */
function tokenDecimals(addr: string, chainId: number): number {
  const lower = addr.toLowerCase()
  const tokens = getChainTokens(chainId)
  if (lower === '0x0000000000000000000000000000000000000000') return 18
  for (const cfg of Object.values(tokens)) {
    if (cfg.address && cfg.address.toLowerCase() === lower) return cfg.decimals
  }
  return 18
}

function tokenDecimalsForAllowance(allowance: AgentAllowance, chainId: number): number {
  return getTokenDecimals(chainId, allowance.token_symbol) ?? tokenDecimals(allowance.token_address, chainId)
}

function formatConfiguredAllowance(allowance: AgentAllowance, chainId: number): string {
  try {
    return formatAllowanceAmount(
      BigInt(allowance.allowance_amount).toString(),
      tokenDecimalsForAllowance(allowance, chainId),
      { symbol: allowance.token_symbol },
    )
  } catch {
    return allowance.allowance_amount
  }
}

/** Format relative time until a date */
function timeUntil(date: Date): string {
  const diffMs = date.getTime() - Date.now()
  if (diffMs <= 0) return 'now'
  const mins = Math.floor(diffMs / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

// ── Icons ──────────────────────────────────────────────────────────

function BotIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="8" width="14" height="10" rx="3" />
      <path d="M12 5v3M9.5 12h.01M14.5 12h.01M9 16h6" />
    </svg>
  )
}

// ── Allowance bar (on-chain primary) ──────────────────────────────

function AllowanceBar({
  info,
  loading,
  chainId = 100,
}: {
  info: AllowanceInfo
  loading?: boolean
  chainId?: number
}) {
  const decimals = tokenDecimals(info.token, chainId)
  const symbol = tokenSymbol(info.token, chainId)
  const effective = computeEffectiveAllowance(info)
  const total = info.amount
  const spent = effective.effectiveSpent
  const remaining = effective.remaining
  const pct = total > 0n ? Number((spent * 100n) / total) : 0
  const nearLimit = pct >= 90 && remaining > 0n
  // Semantic bar fills via design-system tokens (--v2-bar-fill-*) — these
  // replace the previous hardcoded indigo / amber / red Tailwind gradients
  // so the colors are consistent with the rest of the v2 palette.
  const fillStyle =
    pct < 40
      ? 'var(--v2-bar-fill-ok)'
      : pct < 75
        ? 'var(--v2-bar-fill-warn)'
        : 'var(--v2-bar-fill-danger)'

  // Animate bar width from 0 to target on mount
  const [displayPct, setDisplayPct] = useState(0)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setDisplayPct(Math.min(pct, 100)))
    return () => cancelAnimationFrame(frame)
  }, [pct])

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-[var(--v2-ink-2)] font-medium flex items-center gap-1.5">
          {symbol}
          {nearLimit && (
            <span
              className="inline-flex items-center gap-1 rounded bg-[var(--v2-danger-soft)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--v2-danger)] animate-pending-pulse"
              title={`${pct}% of allowance spent`}
            >
              <span className="w-1 h-1 rounded-full bg-[var(--v2-danger)]" />
              near limit
            </span>
          )}
          {loading && (
            <span className="ml-1 text-[var(--v2-ink-3)] animate-pulse">...</span>
          )}
        </span>
        <span className="text-[var(--v2-ink-3)]">
          <span className="v2-tabular">{formatAllowanceAmount(remaining.toString(), decimals, { symbol })}</span>
          {' / '}
          <span className="v2-tabular">{formatAllowanceAmount(total.toString(), decimals, { symbol })}</span>
          {' remaining'}
          {info.resetTimeMin > 0 && (
            <span className="text-[var(--v2-ink-3)] ml-1">
              {budgetPeriodLabel(info.resetTimeMin)}
            </span>
          )}
        </span>
      </div>
      <div
        className={`w-full h-[3px] bg-[var(--v2-surface-2)] rounded-full overflow-hidden ${
          nearLimit ? 'ring-1 ring-[var(--v2-danger)]/30 ring-offset-0' : ''
        }`}
      >
        <div
          className={`h-full rounded-full allowance-fill ${nearLimit ? 'animate-pulse' : ''}`}
          style={{ width: `${displayPct}%`, background: fillStyle }}
        />
      </div>
      {/* Reset info */}
      {effective.isResetPending && (
        <p className="text-xs text-[var(--v2-success)]">
          Reset pending — full allowance available
        </p>
      )}
      {!effective.isResetPending && effective.nextResetTime && (
        <p className="text-xs text-[var(--v2-ink-3)]">
          Resets in {timeUntil(effective.nextResetTime)}
        </p>
      )}
      {remaining === 0n && total > 0n && !effective.isResetPending && (
        <p className="text-xs text-[var(--v2-danger)]">
          Fully spent{info.resetTimeMin > 0 ? ' — resets ' + (effective.nextResetTime ? 'in ' + timeUntil(effective.nextResetTime) : 'next period') : ''}
        </p>
      )}
    </div>
  )
}

function AllowanceBarSkeleton({ symbol }: { symbol: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-[var(--v2-ink-2)]">{symbol}</span>
      <div className="flex-1 h-[3px] bg-[var(--v2-surface-2)] rounded-full" />
      <span className="text-[var(--v2-ink-3)] animate-pulse">loading...</span>
    </div>
  )
}

function ConfiguredAllowanceRow({
  allowance,
  chainId,
}: {
  allowance: AgentAllowance
  chainId: number
}) {
  const reset = budgetPeriodLabel(allowance.reset_period_min)

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-[var(--v2-ink-2)]">{allowance.token_symbol}</span>
        <span className="text-right text-[var(--v2-ink-3)]">
          <span className="v2-tabular">{formatConfiguredAllowance(allowance, chainId)}</span>
          {` ${allowance.token_symbol}`}
          {allowance.reset_period_min > 0 ? ` ${reset}` : ''}
        </span>
      </div>
      <div className="h-[3px] w-full rounded-full bg-[var(--v2-surface-2)]">
        <div className="h-full w-full rounded-full bg-[var(--v2-brand)]/25" />
      </div>
      <p className="text-xs text-[var(--v2-ink-3)]">Configured in Haven</p>
    </div>
  )
}

// ── Agent card ─────────────────────────────────────────────────────

function AgentCard({
  agent,
  onChainAllowances,
  onChainLoading,
  onViewDetails,
  onEdit,
  onPause,
  onResume,
  onRevoke,
  onDelete,
  busyAction,
  canUseWalletActions,
  chainId = 100,
}: {
  agent: Agent
  onChainAllowances: AllowanceInfo[] | null
  onChainLoading: boolean
  onViewDetails: (agent: Agent) => void
  onEdit: (agent: Agent) => void
  onPause: (agent: Agent) => void
  onResume: (agent: Agent) => void
  onRevoke: (agent: Agent) => void
  onDelete: (agent: Agent) => void
  busyAction: 'pause' | 'resume' | 'revoke' | 'delete' | null
  canUseWalletActions: boolean
  chainId?: number
}) {
  const [pauseModalOpen, setPauseModalOpen] = useState(false)
  const [revokeModalOpen, setRevokeModalOpen] = useState(false)
  const [deleteModalOpen, setDeleteModalOpen] = useState(false)

  const isActive = agent.status === 'active'
  const isPaused = agent.status === 'paused'
  const isRevoked = agent.status === 'revoked'
  const isOperational = !isRevoked
  const isBusy = busyAction !== null

  async function handleConfirmPause() {
    setPauseModalOpen(false)
    onPause(agent)
  }

  async function handleConfirmRevoke() {
    setRevokeModalOpen(false)
    onRevoke(agent)
  }

  async function handleConfirmDelete() {
    setDeleteModalOpen(false)
    onDelete(agent)
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
            <BotIcon size={17} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-[var(--v2-ink)] truncate">
                {agent.name}
              </h3>
              {!isActive ? (
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
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
        <div className="mb-3 flex items-start gap-2 px-3 py-2.5 bg-[var(--v2-warning-soft)] border border-[var(--v2-warning)]/20 rounded-lg">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--v2-warning)] flex-shrink-0 mt-0.5">
            <circle cx="12" cy="12" r="10" />
            <path d="M10 15V9" />
            <path d="M14 15V9" />
          </svg>
          <div>
            <p className="text-xs font-medium text-[var(--v2-warning)]">Paused in Haven</p>
            <p className="mt-0.5 text-xs leading-relaxed text-[var(--v2-warning)]">
              New agent payments are blocked until you resume this agent. Existing network permissions stay in place.
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
                <AllowanceBar key={info.token} info={info} chainId={chainId} />
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
      <div className="flex items-center gap-2 pt-3 border-t border-[var(--v2-border)]" onClick={stopCardClick}>
        {isOperational && (
          <>
            {canUseWalletActions ? (
              <button
                onClick={() => onEdit(agent)}
                disabled={isBusy}
                aria-label={`Edit ${agent.name}`}
                className="text-xs text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors disabled:opacity-50"
              >
                Edit
              </button>
            ) : (
              <button
                onClick={openDetails}
                disabled={isBusy}
                aria-label={`Open details for ${agent.name}`}
                className="text-xs text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors disabled:opacity-50"
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
                className="text-xs text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors disabled:opacity-50"
              >
                {busyAction === 'pause' ? 'Pausing...' : 'Pause'}
              </button>
            ) : (
              <button
                onClick={() => onResume(agent)}
                disabled={isBusy}
                aria-label={`Resume ${agent.name}`}
                className="text-xs text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors disabled:opacity-50"
              >
                {busyAction === 'resume' ? 'Resuming...' : 'Resume from pause'}
              </button>
            )}
            {canUseWalletActions ? (
              <>
                <span className="text-[var(--v2-border-strong)]">|</span>
                <button
                  onClick={() => setRevokeModalOpen(true)}
                  disabled={isBusy}
                  aria-label={`Revoke ${agent.name}`}
                  className="text-xs text-[var(--v2-ink-3)] hover:text-[var(--v2-danger)] transition-colors disabled:opacity-50"
                >
                  Revoke
                </button>
              </>
            ) : null}
          </>
        )}
        {isRevoked && (
          <>
            <span className="text-[var(--v2-border-strong)]">|</span>
            <span className="text-xs text-[var(--v2-ink-3)]">
              Network access already revoked
            </span>
            <span className="text-[var(--v2-border-strong)]">|</span>
            <button
              onClick={() => setDeleteModalOpen(true)}
              disabled={isBusy}
              aria-label={`Delete ${agent.name}`}
              className="text-xs text-[var(--v2-ink-3)] hover:text-[var(--v2-danger)] transition-colors disabled:opacity-50"
            >
              Delete
            </button>
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
          <div className="rounded-lg border border-[var(--v2-brand)]/15 bg-[var(--v2-brand-soft)] px-3 py-3 text-[var(--v2-ink-2)]">
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
          <div className="rounded-lg border border-[var(--v2-danger)]/15 bg-[var(--v2-danger-soft)] px-3 py-3 text-[var(--v2-ink-2)]">
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

    <ConfirmDialog
      open={deleteModalOpen}
      onCancel={() => setDeleteModalOpen(false)}
      onConfirm={handleConfirmDelete}
      title={`Delete ${agent.name}?`}
      body="This removes the agent record from Haven only. It does not restore or change network access, so deletion is only available after the agent has already been revoked."
      confirmLabel="Delete agent"
      loading={busyAction === 'delete'}
    />
    </>
  )
}

// ── Unmanaged delegate card ───────────────────────────────────────

function UnmanagedDelegateCard({
  delegate,
  allowances,
  chainId = 100,
}: {
  delegate: string
  allowances: AllowanceInfo[]
  chainId?: number
}) {
  return (
    <div className="rounded-[10px] border border-dashed border-[var(--v2-warning)]/25 bg-[var(--v2-warning-soft)] p-5">
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-white text-[var(--v2-warning)] flex items-center justify-center">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 9v4M12 17h.01" />
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-[var(--v2-ink)]">
                Unmanaged Delegate
              </h3>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-white text-[var(--v2-warning)]">
                network only
              </span>
            </div>
            <p className="text-xs text-[var(--v2-warning)] mt-0.5">
              This delegate was set up outside Haven
            </p>
          </div>
        </div>
      </div>

      {/* Delegate address */}
      <div className="mb-4">
        <p className="mb-1 text-xs font-medium text-[var(--v2-warning)]">
          Signing address
        </p>
        <p className="text-xs font-mono text-[var(--v2-ink-2)]">
          {truncate(delegate)}
          <button
            onClick={() => navigator.clipboard.writeText(delegate)}
            className="ml-2 text-[var(--v2-warning)] hover:text-[var(--v2-ink)] transition-colors"
            title="Copy address"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
        </p>
      </div>

      {/* On-chain allowances */}
      {allowances.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-[var(--v2-warning)]">Agent budget</p>
          {allowances.map((info) => (
            <AllowanceBar key={info.token} info={info} chainId={chainId} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main panel ─────────────────────────────────────────────────────

export default function AgentPanel() {
  const { activeSafe } = useAuth()
  const safeAddress = activeSafe?.safe_address ?? null
  const chainId = activeSafe?.chain_id ?? 100
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
  const signer = useActiveSigner({
    safeAddress: safeAddress ? (safeAddress as Address) : undefined,
    chainId,
  })

  const [createOpen, setCreateOpen] = useState(false)
  const [connect2Open, setConnect2Open] = useState(false)
  const [editAgent, setEditAgent] = useState<Agent | null>(null)
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<'pause' | 'resume' | 'revoke' | 'delete' | null>(null)
  const [showRevokedAgents, setShowRevokedAgents] = useState(false)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const showConnectAgent2 = connectAgent2Enabled()
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
      const agentChainId = agent.safe_chain_id ?? 100
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
    loading: onChainLoading,
    onChainDelegates,
    refetch: refetchOnChain,
  } = useOnChainAllowances(safeAddress, managedDelegates, chainId)

  // Find delegates that exist on-chain but not in Haven DB
  const unmanagedDelegates = useMemo(() => {
    const managedSet = new Set(managedDelegates.map((a) => a.toLowerCase()))
    return onChainDelegates
      .filter((d) => !managedSet.has(d.toLowerCase()))
      .map((d) => ({
        address: d,
        allowances: onChainData.get(d.toLowerCase())?.allowances ?? [],
      }))
      .filter((d) => d.allowances.length > 0) // only show if they have allowances
  }, [onChainDelegates, managedDelegates, onChainData])

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

  function handleViewDetails(agent: Agent) {
    window.location.href = `/agents/${agent.id}`
  }

  // ── Render ─────────────────────────────────────────────

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
      {toastMessage && (
        <div className="fixed right-4 top-4 z-[250] pointer-events-none">
          <div className="rounded-lg border border-[var(--v2-danger)]/20 bg-white px-4 py-3 shadow-[var(--v2-shadow-modal)]">
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 rounded-full bg-[var(--v2-danger-soft)] text-[var(--v2-danger)] flex items-center justify-center flex-shrink-0">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <p className="text-sm font-medium text-[var(--v2-ink)]">{toastMessage}</p>
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
          {!showConnectAgent2 && (
            // Legacy manual setup — only visible when ConnectAgent2 is disabled.
            <Button
              onClick={() => setCreateOpen(true)}
              size="sm"
              variant="ghost"
            >
              Manual setup
            </Button>
          )}
          <Button
            onClick={() => showConnectAgent2 ? setConnect2Open(true) : setCreateOpen(true)}
            size="sm"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
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

      {/* Empty state */}
      {!loading && agents.length === 0 && unmanagedDelegates.length === 0 && (
        <EmptyState
          icon={<BotIcon size={24} />}
          title="No agents yet"
          body="Set agent rules, then add your Haven credential to your agent so it can make payments within those rules."
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button onClick={() => showConnectAgent2 ? setConnect2Open(true) : setCreateOpen(true)}>
                Connect agent
              </Button>
              {!showConnectAgent2 && (
                <Button onClick={() => setCreateOpen(true)} variant="ghost">Manual setup</Button>
              )}
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
                const usesActiveSafe = agentUsesActiveSafe(agent)
                const chainData = delegateKey && usesActiveSafe
                  ? onChainData.get(delegateKey)?.allowances ?? null
                  : null
                const agentChainId = agent.safe_chain_id ?? chainId

                return (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    onChainAllowances={chainData}
                    onChainLoading={usesActiveSafe ? onChainLoading : false}
                    onViewDetails={handleViewDetails}
                    onEdit={handleEdit}
                    onPause={handlePause}
                    onResume={handleResume}
                    onRevoke={handleRevoke}
                    onDelete={handleDelete}
                    busyAction={busyAgentId === agent.id ? busyAction : null}
                    canUseWalletActions={usesActiveSafe}
                    chainId={agentChainId}
                  />
                )
              })}
            </div>
          )}

          {revokedAgents.length > 0 && (
            <div className="pt-1">
              <button
                onClick={() => setShowRevokedAgents((prev) => !prev)}
                className="inline-flex items-center gap-2 text-xs text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)] transition-colors"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={`transition-transform ${showRevokedAgents ? 'rotate-90' : ''}`}
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                {showRevokedAgents ? 'Hide revoked agents' : 'Show revoked agents'}
                <span className="text-[var(--v2-ink-3)] v2-tabular">({revokedAgents.length})</span>
              </button>
            </div>
          )}

          {showRevokedAgents && (
            <div className="grid items-start gap-4 lg:grid-cols-2">
              {revokedAgents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  onChainAllowances={null}
                  onChainLoading={false}
                  onViewDetails={handleViewDetails}
                  onEdit={handleEdit}
                  onPause={handlePause}
                  onResume={handleResume}
                  onRevoke={handleRevoke}
                  onDelete={handleDelete}
                  busyAction={busyAgentId === agent.id ? busyAction : null}
                  canUseWalletActions={agentUsesActiveSafe(agent)}
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
              chainId={chainId}
            />
          ))}
        </div>
      )}

      {/* Create modal */}
      <CreateAgentModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        safeAddress={safeAddress}
        safeId={activeSafe?.id}
        onCreated={() => {
          // Don't close the modal here — the Done step shows the one-time
          // setup file / skill bundle / raw credentials. User dismisses via
          // the Done button, which fires onClose.
          refetch()
          // Refresh network data after a short delay for tx confirmation
          setTimeout(refetchOnChain, 2000)
        }}
      />

      {showConnectAgent2 && (
        <ConnectAgent2Modal
          open={connect2Open}
          onClose={() => setConnect2Open(false)}
          safeAddress={safeAddress}
          safeId={activeSafe?.id}
          onSetupUpdated={refetch}
        />
      )}

      {/* Edit agent modal */}
      {editAgent && agentUsesActiveSafe(editAgent) && (
        <EditAgentModal
          open={!!editAgent}
          onClose={() => setEditAgent(null)}
          agent={editAgent}
          safeAddress={safeAddress}
          chainId={chainId}
          safeDetails={safeDetails}
          existingOnChainAllowances={
            onChainData.get(editAgent.delegate_address?.toLowerCase() ?? '')?.allowances ?? null
          }
          onUpdated={() => {
            refetch()
            setEditAgent(null)
            setTimeout(refetchOnChain, 2000)
          }}
        />
      )}
    </div>
  )
}
