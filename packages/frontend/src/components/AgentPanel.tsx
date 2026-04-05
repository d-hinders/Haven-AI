'use client'

import { useEffect, useState, useCallback } from 'react'
import { usePublicClient, useWalletClient, useAccount } from 'wagmi'
import { type Address, hashTypedData } from 'viem'
import { gnosis } from 'viem/chains'
import { useAuth } from '@/context/AuthContext'
import { useAgents, type Agent } from '@/hooks/useAgents'
import { useSafeDetails } from '@/hooks/useSafeDetails'
import {
  getAllAllowances,
  buildAgentRevokeTx,
  RESET_PERIODS,
  type AllowanceInfo,
} from '@/lib/allowance-module'
import { getSafeNonce, signSafeTx, executeSafeTx, proposeSafeTx, TOKENS } from '@/lib/safe-tx'
import CreateAgentModal from './CreateAgentModal'
import HowItWorksModal from './HowItWorksModal'

// ── Helpers ────────────────────────────────────────────────────────

function truncate(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function resetLabel(mins: number) {
  return RESET_PERIODS.find((p) => p.value === mins)?.label ?? `${mins}m`
}

/** Resolve token address to symbol */
function tokenSymbol(addr: string): string {
  const lower = addr.toLowerCase()
  if (lower === '0x0000000000000000000000000000000000000000') return 'xDAI'
  for (const [symbol, cfg] of Object.entries(TOKENS)) {
    if (cfg.address && cfg.address.toLowerCase() === lower) return symbol
  }
  return truncate(addr)
}

/** Resolve token address to decimals */
function tokenDecimals(addr: string): number {
  const lower = addr.toLowerCase()
  if (lower === '0x0000000000000000000000000000000000000000') return 18
  for (const cfg of Object.values(TOKENS)) {
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

// ── Allowance bar ──────────────────────────────────────────────────

function AllowanceBar({
  info,
  configuredSymbol,
}: {
  info: AllowanceInfo | null
  configuredSymbol: string
}) {
  if (!info) {
    // Show configured data only (no on-chain data yet)
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="text-zinc-500">{configuredSymbol}</span>
        <div className="flex-1 h-[3px] bg-white/[0.05] rounded-full" />
        <span className="text-zinc-700">loading...</span>
      </div>
    )
  }

  const decimals = tokenDecimals(info.token)
  const total = info.amount
  const spent = info.spent
  const pct = total > 0n ? Number((spent * 100n) / total) : 0
  const color =
    pct < 40
      ? 'from-indigo-500 to-violet-500'
      : pct < 75
        ? 'from-amber-500 to-orange-500'
        : 'from-red-500 to-rose-500'

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-zinc-400 font-medium">
          {tokenSymbol(info.token)}
        </span>
        <span className="text-zinc-600">
          {formatAmount(spent, decimals)} / {formatAmount(total, decimals)}
          {info.resetTimeMin > 0 && (
            <span className="text-zinc-700 ml-1">
              per {resetLabel(info.resetTimeMin).toLowerCase()}
            </span>
          )}
        </span>
      </div>
      <div className="w-full h-[3px] bg-white/[0.05] rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${color} transition-all`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    </div>
  )
}

// ── Agent card ─────────────────────────────────────────────────────

function AgentCard({
  agent,
  onChainAllowances,
  onRevoke,
  onDelete,
  revoking,
}: {
  agent: Agent
  onChainAllowances: AllowanceInfo[] | null
  onRevoke: (agent: Agent) => void
  onDelete: (agent: Agent) => void
  revoking: boolean
}) {
  const [showKey, setShowKey] = useState(false)
  const [copied, setCopied] = useState(false)
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const isActive = agent.status === 'active'

  function copyKey() {
    navigator.clipboard.writeText(agent.api_key)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-5 hover:border-white/[0.1] transition-all">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div
            className={`w-9 h-9 rounded-xl flex items-center justify-center ${
              isActive
                ? 'bg-indigo-500/10 text-indigo-400'
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
                    : agent.status === 'revoked'
                      ? 'bg-red-500/10 text-red-400'
                      : 'bg-zinc-800 text-zinc-500'
                }`}
              >
                {agent.status}
              </span>
            </div>
            {agent.description && (
              <p className="text-xs text-zinc-600 mt-0.5">
                {agent.description}
              </p>
            )}
          </div>
        </div>
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

      {/* Allowance bars */}
      {isActive && (
        <div className="space-y-2 mb-4">
          <p className="text-[10px] text-zinc-700 uppercase tracking-wide">
            Spending limits
          </p>
          {agent.allowances.length > 0 ? (
            agent.allowances.map((a) => {
              const chainInfo = onChainAllowances?.find(
                (oc) => oc.token.toLowerCase() === a.token_address.toLowerCase(),
              )
              return (
                <AllowanceBar
                  key={a.token_address}
                  info={chainInfo ?? null}
                  configuredSymbol={a.token_symbol}
                />
              )
            })
          ) : (
            <p className="text-xs text-zinc-700">No allowances configured</p>
          )}
        </div>
      )}

      {/* API Key */}
      {isActive && (
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
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      {/* Actions */}
      {isActive && (
        <div className="flex items-center gap-2 pt-3 border-t border-white/[0.05]">
          {confirmRevoke ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-zinc-500">Revoke on-chain?</span>
              <button
                onClick={() => onRevoke(agent)}
                disabled={revoking}
                className="text-red-400 hover:text-red-300 font-medium transition-colors disabled:opacity-50"
              >
                {revoking ? 'Revoking...' : 'Yes'}
              </button>
              <button
                onClick={() => setConfirmRevoke(false)}
                className="text-zinc-600 hover:text-zinc-400 transition-colors"
              >
                No
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmRevoke(true)}
              className="text-xs text-zinc-600 hover:text-red-400 transition-colors"
            >
              Revoke
            </button>
          )}
          <span className="text-zinc-800">|</span>
          {confirmDelete ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-zinc-500">Delete?</span>
              <button
                onClick={() => onDelete(agent)}
                className="text-red-400 hover:text-red-300 font-medium transition-colors"
              >
                Yes
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="text-zinc-600 hover:text-zinc-400 transition-colors"
              >
                No
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="text-xs text-zinc-600 hover:text-red-400 transition-colors"
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main panel ─────────────────────────────────────────────────────

export default function AgentPanel() {
  const { user } = useAuth()
  const safeAddress = user?.safe_address ?? null
  const { details: safeDetails } = useSafeDetails(safeAddress)
  const { agents, loading, revokeAgent, deleteAgent, refetch } = useAgents()
  const { address: connectedAddress } = useAccount()
  const publicClient = usePublicClient({ chainId: gnosis.id })
  const { data: walletClient } = useWalletClient({ chainId: gnosis.id })

  const [createOpen, setCreateOpen] = useState(false)
  const [howItWorksOpen, setHowItWorksOpen] = useState(false)
  const [revoking, setRevoking] = useState(false)

  // On-chain allowance data keyed by delegate address
  const [onChainData, setOnChainData] = useState<
    Map<string, AllowanceInfo[]>
  >(new Map())

  // Fetch on-chain allowances for all active agents
  const fetchOnChainData = useCallback(async () => {
    if (!publicClient || !safeAddress) return

    const activeAgents = agents.filter(
      (a) => a.status === 'active' && a.delegate_address,
    )
    if (activeAgents.length === 0) return

    const results = new Map<string, AllowanceInfo[]>()
    await Promise.all(
      activeAgents.map(async (agent) => {
        try {
          const allowances = await getAllAllowances(
            publicClient,
            safeAddress as Address,
            agent.delegate_address as Address,
          )
          results.set(agent.delegate_address!.toLowerCase(), allowances)
        } catch {
          // Agent might not be set up on-chain yet
        }
      }),
    )
    setOnChainData(results)
  }, [publicClient, safeAddress, agents])

  useEffect(() => {
    fetchOnChainData()
  }, [fetchOnChainData])

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

    setRevoking(true)
    try {
      const nonce = await getSafeNonce(publicClient, safeAddress as Address)
      const safeTx = buildAgentRevokeTx(agent.delegate_address as Address, nonce)
      const signature = await signSafeTx(
        walletClient,
        safeAddress as Address,
        safeTx,
        connectedAddress,
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
        )
      } else {
        const safeTxHash = hashTypedData({
          domain: {
            chainId: gnosis.id,
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
        )
      }

      // Update in Haven backend
      await revokeAgent(agent.id)
      fetchOnChainData()
    } catch (err) {
      // If user rejected, just ignore
      if (
        err instanceof Error &&
        !err.message.includes('rejected') &&
        !err.message.includes('denied')
      ) {
        console.error('Revoke failed:', err)
      }
    } finally {
      setRevoking(false)
    }
  }

  async function handleDelete(agent: Agent) {
    try {
      await deleteAgent(agent.id)
    } catch (err) {
      console.error('Delete failed:', err)
    }
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
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <p className="text-xs text-zinc-600">
            {agents.filter((a) => a.status === 'active').length} active agent
            {agents.filter((a) => a.status === 'active').length !== 1 ? 's' : ''}
          </p>
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
            Create Agent
          </button>
        </div>
      </div>

      {/* Loading */}
      {loading && agents.length === 0 && (
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
      {!loading && agents.length === 0 && (
        <div className="flex flex-col items-center justify-center h-64 rounded-xl border border-dashed border-white/[0.06]">
          <div className="w-12 h-12 rounded-xl bg-white/[0.04] flex items-center justify-center mb-3">
            <BotIcon size={24} />
          </div>
          <p className="text-sm text-zinc-500 mb-1">No agents yet</p>
          <p className="text-xs text-zinc-700 mb-4 max-w-xs text-center">
            Create an agent to give it constrained spending authority on your Safe
          </p>
          <button
            onClick={() => setCreateOpen(true)}
            className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            + Create your first agent
          </button>
        </div>
      )}

      {/* Agent list */}
      {agents.length > 0 && (
        <div className="space-y-3">
          {agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              onChainAllowances={
                agent.delegate_address
                  ? onChainData.get(agent.delegate_address.toLowerCase()) ?? null
                  : null
              }
              onRevoke={handleRevoke}
              onDelete={handleDelete}
              revoking={revoking}
            />
          ))}
        </div>
      )}

      {/* Create modal */}
      <CreateAgentModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        safeAddress={safeAddress}
        safeDetails={safeDetails}
        onCreated={() => {
          refetch()
          setCreateOpen(false)
          // Refresh on-chain data after a short delay
          setTimeout(fetchOnChainData, 2000)
        }}
      />

      {/* How it works modal */}
      <HowItWorksModal
        open={howItWorksOpen}
        onClose={() => setHowItWorksOpen(false)}
      />
    </div>
  )
}
