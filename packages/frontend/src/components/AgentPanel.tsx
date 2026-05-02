'use client'

import { useState, useMemo, useEffect } from 'react'
import { usePublicClient, useWalletClient, useAccount } from 'wagmi'
import { type Address, hashTypedData } from 'viem'
import { useAuth } from '@/context/AuthContext'
import { useAgents, type Agent } from '@/hooks/useAgents'
import { useOnChainAllowances } from '@/hooks/useOnChainAllowances'
import { useSafeDetails } from '@/hooks/useSafeDetails'
import {
  buildAgentRevokeTx,
  computeEffectiveAllowance,
  RESET_PERIODS,
  type AllowanceInfo,
} from '@/lib/allowance-module'
import { getSafeNonce, signSafeTx, executeSafeTx, proposeSafeTx, getChainTokens } from '@/lib/safe-tx'
import CreateAgentModal from './CreateAgentModal'
import EditAgentModal from './EditAgentModal'
import HowItWorksModal from './HowItWorksModal'
import AgentActivityFeed from './AgentActivityFeed'
import ConfirmDialog from './ConfirmDialog'
import { truncate } from '@/lib/format'

// ── Helpers ────────────────────────────────────────────────────────

function resetLabel(mins: number) {
  return RESET_PERIODS.find((p) => p.value === mins)?.label ?? `${mins}m`
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

/** Format raw bigint to human-readable amount */
function formatAmount(raw: bigint, decimals: number): string {
  if (raw === 0n) return '0'
  const str = raw.toString().padStart(decimals + 1, '0')
  const intPart = str.slice(0, str.length - decimals) || '0'
  const fracPart = str.slice(str.length - decimals)
  const trimmed = fracPart.replace(/0+$/, '').padEnd(2, '0').slice(0, 6)
  return `${intPart}.${trimmed}`
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
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <circle cx="12" cy="5" r="2" />
      <path d="M12 7v4" />
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
  const effective = computeEffectiveAllowance(info)
  const total = info.amount
  const spent = effective.effectiveSpent
  const remaining = effective.remaining
  const pct = total > 0n ? Number((spent * 100n) / total) : 0
  const nearLimit = pct >= 90 && remaining > 0n
  const color =
    pct < 40
      ? 'from-indigo-500 to-violet-500'
      : pct < 75
        ? 'from-amber-500 to-orange-500'
        : 'from-red-500 to-rose-500'

  // Animate bar width from 0 to target on mount
  const [displayPct, setDisplayPct] = useState(0)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setDisplayPct(Math.min(pct, 100)))
    return () => cancelAnimationFrame(frame)
  }, [pct])

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-zinc-400 font-medium flex items-center gap-1.5">
          {tokenSymbol(info.token, chainId)}
          {nearLimit && (
            <span
              className="inline-flex items-center gap-1 text-[9px] px-1 py-0.5 rounded bg-red-500/10 text-red-400 font-semibold uppercase tracking-wide animate-pulse"
              title={`${pct}% of allowance spent`}
            >
              <span className="w-1 h-1 rounded-full bg-red-400" />
              near limit
            </span>
          )}
          {loading && (
            <span className="ml-1 text-zinc-700 animate-pulse">...</span>
          )}
        </span>
        <span className="text-zinc-600">
          {formatAmount(remaining, decimals)} / {formatAmount(total, decimals)} remaining
          {info.resetTimeMin > 0 && (
            <span className="text-zinc-700 ml-1">
              per {resetLabel(info.resetTimeMin).toLowerCase()}
            </span>
          )}
        </span>
      </div>
      <div
        className={`w-full h-[3px] bg-white/[0.05] rounded-full overflow-hidden ${
          nearLimit ? 'ring-1 ring-red-500/30 ring-offset-0' : ''
        }`}
      >
        <div
          className={`h-full rounded-full bg-gradient-to-r ${color} allowance-fill ${
            nearLimit ? 'animate-pulse' : ''
          }`}
          style={{ width: `${displayPct}%` }}
        />
      </div>
      {/* Reset info */}
      {effective.isResetPending && (
        <p className="text-[10px] text-emerald-500/70">
          Reset pending — full allowance available
        </p>
      )}
      {!effective.isResetPending && effective.nextResetTime && (
        <p className="text-[10px] text-zinc-700">
          Resets in {timeUntil(effective.nextResetTime)}
        </p>
      )}
      {remaining === 0n && total > 0n && !effective.isResetPending && (
        <p className="text-[10px] text-red-400/70">
          Fully spent{info.resetTimeMin > 0 ? ' — resets ' + (effective.nextResetTime ? 'in ' + timeUntil(effective.nextResetTime) : 'next period') : ''}
        </p>
      )}
    </div>
  )
}

function AllowanceBarSkeleton({ symbol }: { symbol: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-zinc-500">{symbol}</span>
      <div className="flex-1 h-[3px] bg-white/[0.05] rounded-full" />
      <span className="text-zinc-700 animate-pulse">loading...</span>
    </div>
  )
}

// ── Agent card ─────────────────────────────────────────────────────

function AgentCard({
  agent,
  onChainAllowances,
  onChainLoading,
  onEdit,
  onViewActivity,
  onPause,
  onResume,
  onRevoke,
  onDelete,
  busyAction,
  chainId = 100,
}: {
  agent: Agent
  onChainAllowances: AllowanceInfo[] | null
  onChainLoading: boolean
  onEdit: (agent: Agent) => void
  onViewActivity: (agent: Agent) => void
  onPause: (agent: Agent) => void
  onResume: (agent: Agent) => void
  onRevoke: (agent: Agent) => void
  onDelete: (agent: Agent) => void
  busyAction: 'pause' | 'resume' | 'revoke' | 'delete' | null
  chainId?: number
}) {
  const [showKey, setShowKey] = useState(false)
  const [copied, setCopied] = useState(false)
  const [pauseModalOpen, setPauseModalOpen] = useState(false)
  const [revokeModalOpen, setRevokeModalOpen] = useState(false)
  const [deleteModalOpen, setDeleteModalOpen] = useState(false)

  const isActive = agent.status === 'active'
  const isPaused = agent.status === 'paused'
  const isRevoked = agent.status === 'revoked'
  const isOperational = !isRevoked
  const isBusy = busyAction !== null

  function copyKey() {
    navigator.clipboard.writeText(agent.api_key)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

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

  // Merge on-chain + DB allowance data: on-chain is primary, DB fills gaps
  const displayAllowances = useMemo(() => {
    if (onChainAllowances && onChainAllowances.length > 0) {
      return onChainAllowances
    }
    // No on-chain data yet — nothing to show
    return null
  }, [onChainAllowances])

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
    <div className={`bg-white/[0.02] border rounded-xl p-5 transition-all ${
      isRevoked
        ? 'border-white/[0.04] opacity-80'
        : 'border-white/[0.06] hover:border-white/[0.1]'
    }`}>
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div
            className={`w-9 h-9 rounded-xl flex items-center justify-center ${
              isActive
                ? 'bg-indigo-500/10 text-indigo-400'
                : isPaused
                  ? 'bg-amber-500/10 text-amber-400'
                  : 'bg-white/[0.04] text-zinc-600'
            }`}
          >
            <BotIcon size={17} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-zinc-200">
                {agent.name}
              </h3>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                  isActive
                    ? 'bg-emerald-500/10 text-emerald-400'
                    : isPaused
                      ? 'bg-amber-500/10 text-amber-400'
                      : agent.status === 'revoked'
                      ? 'bg-red-500/10 text-red-400'
                      : 'bg-zinc-800 text-zinc-500'
                }`}
              >
                {agent.status}
              </span>
            </div>
            {agent.safe_name && (
              <p className="text-xs text-zinc-500 mt-0.5">
                <span className="text-zinc-600">Account:</span> {agent.safe_name}
              </p>
            )}
            {agent.description && (
              <p className="text-xs text-zinc-600 mt-0.5">
                {agent.description}
              </p>
            )}
          </div>
        </div>
        <button
          onClick={() => onViewActivity(agent)}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all ${
            isRevoked
              ? 'border-white/[0.06] bg-white/[0.02] text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]'
              : 'border-indigo-500/20 bg-indigo-500/10 text-indigo-300 hover:bg-indigo-500/15 hover:text-indigo-200'
          }`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
          Activity
        </button>
      </div>

      {/* Delegate address */}
      {agent.delegate_address && (
        <div className="mb-4">
          <p className="text-[10px] text-zinc-700 uppercase tracking-wide mb-1">
            Delegate
          </p>
          <p className="text-xs font-mono text-zinc-500">
            {truncate(agent.delegate_address)}
            <button
              onClick={() => navigator.clipboard.writeText(agent.delegate_address!)}
              className="ml-2 text-zinc-700 hover:text-zinc-400 transition-colors"
              title="Copy address"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </button>
          </p>
        </div>
      )}

      {/* Recipient restriction indicator */}
      {isOperational && agent.restrict_recipients && (
        <div className="mb-4 flex items-center gap-2 px-2.5 py-1.5 bg-indigo-500/5 border border-indigo-500/10 rounded-lg">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-indigo-400 flex-shrink-0">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <span className="text-[10px] text-indigo-400">
            Restricted to {agent.allowed_recipients?.length ?? 0} allowed recipient{(agent.allowed_recipients?.length ?? 0) !== 1 ? 's' : ''}
          </span>
        </div>
      )}

      {isPaused && (
        <div className="mb-4 flex items-start gap-2 px-3 py-2.5 bg-amber-500/8 border border-amber-500/20 rounded-lg">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-400 flex-shrink-0 mt-0.5">
            <circle cx="12" cy="12" r="10" />
            <path d="M10 15V9" />
            <path d="M14 15V9" />
          </svg>
          <div>
            <p className="text-[11px] font-medium text-amber-300">Paused in Haven</p>
            <p className="text-[11px] text-amber-200/80 leading-relaxed">
              New API-initiated transactions are blocked until you resume this agent. On-chain delegate access and allowances are still in place.
            </p>
          </div>
        </div>
      )}

      {/* Allowance bars — on-chain primary */}
      {isOperational && (
        <div className="space-y-2 mb-4">
          <p className="text-[10px] text-zinc-700 uppercase tracking-wide">
            Spending limits
            <span className="text-zinc-800 ml-1 normal-case">(on-chain)</span>
          </p>

          {/* On-chain allowances */}
          {displayAllowances && displayAllowances.length > 0 ? (
            displayAllowances.map((info) => (
              <AllowanceBar key={info.token} info={info} chainId={chainId} />
            ))
          ) : !onChainLoading && (!displayAllowances || displayAllowances.length === 0) ? (
            <p className="text-xs text-zinc-700">No on-chain allowances found</p>
          ) : null}

          {/* DB tokens still loading from chain */}
          {pendingDbTokens.map((symbol) => (
            <AllowanceBarSkeleton key={symbol} symbol={symbol} />
          ))}
        </div>
      )}

      {/* API Key */}
      {isOperational && (
        <div className="mb-4">
          <p className="text-[10px] text-zinc-700 uppercase tracking-wide mb-1">
            API Key
          </p>
          <div className="flex items-center gap-2">
            <code className="text-xs font-mono text-zinc-600 bg-white/[0.02] rounded px-2 py-1 flex-1 truncate">
              {showKey ? agent.api_key : `sk_agent_${'*'.repeat(16)}`}
            </code>
            <button
              onClick={() => setShowKey(!showKey)}
              className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              {showKey ? 'Hide' : 'Show'}
            </button>
            <button
              onClick={copyKey}
              className="text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              {copied ? (
                <span className="inline-flex items-center gap-1 text-emerald-400 animate-check-pop">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Copied
                </span>
              ) : (
                'Copy'
              )}
            </button>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-3 border-t border-white/[0.05]">
        {isOperational && (
          <>
            <button
              onClick={() => onEdit(agent)}
              disabled={isBusy}
              className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors disabled:opacity-50"
            >
              Edit
            </button>
            <span className="text-zinc-800">|</span>
            {isActive ? (
              <button
                onClick={() => setPauseModalOpen(true)}
                disabled={isBusy}
                className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors disabled:opacity-50"
              >
                {busyAction === 'pause' ? 'Pausing...' : 'Pause'}
              </button>
            ) : (
              <button
                onClick={() => onResume(agent)}
                disabled={isBusy}
                className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors disabled:opacity-50"
              >
                {busyAction === 'resume' ? 'Resuming...' : 'Resume from pause'}
              </button>
            )}
            <span className="text-zinc-800">|</span>
            <button
              onClick={() => setRevokeModalOpen(true)}
              disabled={isBusy}
              className="text-xs text-zinc-600 hover:text-red-400 transition-colors disabled:opacity-50"
            >
              Revoke
            </button>
          </>
        )}
        {isRevoked && (
          <>
            <span className="text-xs text-zinc-600">
              On-chain access already revoked
            </span>
            <span className="text-zinc-800">|</span>
            <button
              onClick={() => setDeleteModalOpen(true)}
              disabled={isBusy}
              className="text-xs text-zinc-600 hover:text-red-400 transition-colors disabled:opacity-50"
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
            Pausing stops this agent from creating new transactions through Haven right away, without changing its on-chain delegate access.
          </p>
          <div className="rounded-lg border border-indigo-500/15 bg-indigo-500/[0.04] px-3 py-3 text-zinc-300">
            <p className="text-xs font-medium text-indigo-300 mb-1">What stays the same</p>
            <p className="text-xs leading-relaxed">
              The Safe delegate and on-chain spending limits remain in place. You can resume this agent later without reconnecting or reconfiguring it.
            </p>
          </div>
          <p className="text-xs text-zinc-500">
            Use Pause for a fast, reversible stop. Use Revoke when you also want to remove the agent&apos;s on-chain spending authority.
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
            This removes the agent&apos;s Haven access immediately and also revokes its on-chain spending authority through your Safe.
          </p>
          <div className="rounded-lg border border-red-500/15 bg-red-500/[0.04] px-3 py-3 text-zinc-300">
            <p className="text-xs font-medium text-red-300 mb-1">What happens next</p>
            <p className="text-xs leading-relaxed">
              Haven will stop accepting new API requests from this agent, and you&apos;ll be asked to sign or propose a Safe transaction that removes the delegate&apos;s on-chain spending access.
            </p>
          </div>
          <p className="text-xs text-zinc-500">
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
      body="This removes the agent record from Haven only. It does not change any on-chain state, so deletion is only available after the agent has already been revoked."
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
    <div className="bg-white/[0.02] border border-dashed border-amber-500/20 rounded-xl p-5">
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-amber-500/10 text-amber-400 flex items-center justify-center">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 9v4M12 17h.01" />
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-zinc-200">
                Unmanaged Delegate
              </h3>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-amber-500/10 text-amber-400">
                on-chain only
              </span>
            </div>
            <p className="text-xs text-zinc-600 mt-0.5">
              This delegate was set up outside Haven
            </p>
          </div>
        </div>
      </div>

      {/* Delegate address */}
      <div className="mb-4">
        <p className="text-[10px] text-zinc-700 uppercase tracking-wide mb-1">
          Delegate
        </p>
        <p className="text-xs font-mono text-zinc-500">
          {truncate(delegate)}
          <button
            onClick={() => navigator.clipboard.writeText(delegate)}
            className="ml-2 text-zinc-700 hover:text-zinc-400 transition-colors"
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
          <p className="text-[10px] text-zinc-700 uppercase tracking-wide">
            Spending limits
            <span className="text-zinc-800 ml-1 normal-case">(on-chain)</span>
          </p>
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
  const { user, activeSafe } = useAuth()
  const safeAddress = activeSafe?.safe_address ?? null
  const chainId = activeSafe?.chain_id ?? 100
  const { details: safeDetails } = useSafeDetails(safeAddress)
  const { agents, loading, revokeAgent, pauseAgent, resumeAgent, deleteAgent, refetch } = useAgents()
  const { address: connectedAddress } = useAccount()
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()

  const [createOpen, setCreateOpen] = useState(false)
  const [createPreset, setCreatePreset] = useState<'demo' | null>(null)
  const [editAgent, setEditAgent] = useState<Agent | null>(null)
  const [howItWorksOpen, setHowItWorksOpen] = useState(false)
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<'pause' | 'resume' | 'revoke' | 'delete' | null>(null)
  const [showRevokedAgents, setShowRevokedAgents] = useState(false)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [activeView, setActiveView] = useState<'agents' | 'activity'>(
    'agents',
  )
  const [activityAgent, setActivityAgent] = useState<Agent | null>(null)
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

  // Collect managed delegate addresses from DB agents
  const managedDelegates = useMemo(
    () =>
      agents
        .filter((a) => a.status !== 'revoked' && a.delegate_address)
        .map((a) => a.delegate_address!),
    [agents],
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

  // ── Revoke handler ─────────────────────────────────────

  async function handleRevoke(agent: Agent) {
    if (
      !publicClient ||
      !walletClient ||
      !connectedAddress ||
      !safeAddress ||
      !safeDetails ||
      !agent.delegate_address
    )
      return

    setBusyAgentId(agent.id)
    setBusyAction('revoke')
    try {
      const nonce = await getSafeNonce(publicClient, safeAddress as Address)
      const safeTx = buildAgentRevokeTx(agent.delegate_address as Address, nonce)
      const signature = await signSafeTx(
        walletClient,
        safeAddress as Address,
        safeTx,
        connectedAddress,
        chainId,
      )

      const threshold = safeDetails.threshold ?? 1
      if (threshold <= 1) {
        await executeSafeTx(
          walletClient,
          publicClient,
          safeAddress as Address,
          safeTx,
          signature,
          connectedAddress,
          chainId,
        )
      } else {
        const safeTxHash = hashTypedData({
          domain: {
            chainId,
            verifyingContract: safeAddress as Address,
          },
          types: {
            SafeTx: [
              { name: 'to', type: 'address' },
              { name: 'value', type: 'uint256' },
              { name: 'data', type: 'bytes' },
              { name: 'operation', type: 'uint8' },
              { name: 'safeTxGas', type: 'uint256' },
              { name: 'baseGas', type: 'uint256' },
              { name: 'gasPrice', type: 'uint256' },
              { name: 'gasToken', type: 'address' },
              { name: 'refundReceiver', type: 'address' },
              { name: 'nonce', type: 'uint256' },
            ],
          },
          primaryType: 'SafeTx',
          message: {
            to: safeTx.to,
            value: safeTx.value,
            data: safeTx.data,
            operation: safeTx.operation,
            safeTxGas: safeTx.safeTxGas,
            baseGas: safeTx.baseGas,
            gasPrice: safeTx.gasPrice,
            gasToken: safeTx.gasToken,
            refundReceiver: safeTx.refundReceiver,
            nonce: safeTx.nonce,
          },
        })
        await proposeSafeTx(
          safeAddress as Address,
          safeTx,
          safeTxHash,
          signature,
          connectedAddress,
          chainId,
        )
      }

      // Update in Haven backend
      await revokeAgent(agent.id)
      refetchOnChain()
    } catch (err) {
      // If user rejected, just ignore
      if (
        err instanceof Error &&
        !err.message.includes('rejected') &&
        !err.message.includes('denied')
      ) {
        console.error('Revoke failed:', err)
        setToastMessage('Revoke failed')
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
      setToastMessage('Pause failed')
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
      setToastMessage('Resume failed')
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
      setToastMessage('Delete failed')
    } finally {
      setBusyAgentId(null)
      setBusyAction(null)
    }
  }

  function handleViewActivity(agent: Agent) {
    setActivityAgent(agent)
    setActiveView('activity')
  }

  // ── Render ─────────────────────────────────────────────

  if (!safeAddress) {
    return (
      <div className="flex flex-col items-center justify-center h-64 rounded-xl border border-dashed border-white/[0.06]">
        <BotIcon size={24} />
        <p className="text-sm text-zinc-500 mt-3">
          Deploy a Safe to manage agents
        </p>
      </div>
    )
  }

  return (
    <div>
      {toastMessage && (
        <div className="fixed right-4 top-4 z-[250] pointer-events-none">
          <div className="rounded-lg border border-red-500/20 bg-[#171518] px-4 py-3 shadow-2xl shadow-black/30">
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 rounded-full bg-red-500/10 text-red-400 flex items-center justify-center flex-shrink-0">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <p className="text-sm font-medium text-zinc-200">{toastMessage}</p>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-1">
          <button
            onClick={() => { setActiveView('agents'); setActivityAgent(null) }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeView === 'agents'
                ? 'bg-white/[0.06] text-zinc-200'
                : 'text-zinc-600 hover:text-zinc-400'
            }`}
          >
            Agents
            <span className="ml-1 text-zinc-700">
              {visibleAgents.length}
            </span>
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setHowItWorksOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-white/[0.08] bg-white/[0.02] text-zinc-400 text-sm font-medium hover:bg-white/[0.05] hover:text-zinc-300 transition-all duration-200"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            How it works
          </button>
          <button
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium hover:from-indigo-400 hover:to-violet-500 transition-all duration-200 shadow-lg shadow-indigo-500/20"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Connect agent
          </button>
        </div>
      </div>

      {/* Activity view */}
      {activeView === 'activity' && activityAgent && (
        <AgentActivityFeed
          agentId={activityAgent.id}
          agentName={activityAgent.name}
          onClose={() => { setActiveView('agents'); setActivityAgent(null) }}
        />
      )}

      {/* Agents view */}
      {activeView === 'agents' && loading && agents.length === 0 && (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-5"
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="w-9 h-9 rounded-xl bg-white/[0.04] animate-pulse" />
                <div className="space-y-2">
                  <div className="h-3 w-32 bg-white/[0.06] rounded animate-pulse" />
                  <div className="h-2 w-48 bg-white/[0.04] rounded animate-pulse" />
                </div>
              </div>
              <div className="h-2 w-full bg-white/[0.04] rounded animate-pulse" />
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {activeView === 'agents' && !loading && agents.length === 0 && unmanagedDelegates.length === 0 && (
        <div className="flex flex-col items-center justify-center h-72 rounded-xl border border-dashed border-white/[0.06] px-6">
          <div className="w-12 h-12 rounded-xl bg-white/[0.04] flex items-center justify-center mb-3">
            <BotIcon size={24} />
          </div>
          <p className="text-sm text-zinc-300 mb-1">No agents yet</p>
          <p className="text-xs text-zinc-500 mb-5 max-w-xs text-center leading-relaxed">
            Set up payment credentials and on-chain spending limits, then hand them off to your agent so it can spend from your Safe within your rules.
          </p>
          <button
            onClick={() => { setCreatePreset(null); setCreateOpen(true) }}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-xs font-medium hover:from-indigo-400 hover:to-violet-500 transition-all duration-200 shadow-lg shadow-indigo-500/20"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Connect agent
          </button>
        </div>
      )}

      {/* Agent list */}
      {activeView === 'agents' && (agents.length > 0 || unmanagedDelegates.length > 0) && (
        <div className="space-y-3">
          {/* Managed agents */}
          {visibleAgents.map((agent) => {
            const delegateKey = agent.delegate_address?.toLowerCase() ?? ''
            const chainData = delegateKey
              ? onChainData.get(delegateKey)?.allowances ?? null
              : null

            return (
              <AgentCard
                key={agent.id}
                agent={agent}
                onChainAllowances={chainData}
                onChainLoading={onChainLoading}
                onEdit={setEditAgent}
                onViewActivity={handleViewActivity}
                onPause={handlePause}
                onResume={handleResume}
                onRevoke={handleRevoke}
                onDelete={handleDelete}
                busyAction={busyAgentId === agent.id ? busyAction : null}
                chainId={chainId}
              />
            )
          })}

          {revokedAgents.length > 0 && (
            <div className="pt-1">
              <button
                onClick={() => setShowRevokedAgents((prev) => !prev)}
                className="inline-flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
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
                <span className="text-zinc-700">({revokedAgents.length})</span>
              </button>
            </div>
          )}

          {showRevokedAgents && revokedAgents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              onChainAllowances={null}
              onChainLoading={false}
              onEdit={setEditAgent}
              onViewActivity={handleViewActivity}
              onPause={handlePause}
              onResume={handleResume}
              onRevoke={handleRevoke}
              onDelete={handleDelete}
              busyAction={busyAgentId === agent.id ? busyAction : null}
              chainId={chainId}
            />
          ))}

          {/* Unmanaged on-chain delegates */}
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
        onClose={() => { setCreateOpen(false); setCreatePreset(null) }}
        safeAddress={safeAddress}
        safeId={activeSafe?.id}
        preset={createPreset}
        onCreated={() => {
          // Don't close the modal here — the Done step shows the one-time
          // handoff file / skill bundle / raw credentials. User dismisses via
          // the Done button, which fires onClose.
          refetch()
          // Refresh on-chain data after a short delay for tx confirmation
          setTimeout(refetchOnChain, 2000)
        }}
      />

      {/* Edit agent modal */}
      {editAgent && (
        <EditAgentModal
          open={!!editAgent}
          onClose={() => setEditAgent(null)}
          agent={editAgent}
          safeAddress={safeAddress}
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

      {/* How it works modal */}
      <HowItWorksModal
        open={howItWorksOpen}
        onClose={() => setHowItWorksOpen(false)}
      />
    </div>
  )
}
