'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { useAccount, usePublicClient, useWalletClient } from 'wagmi'
import { type Address } from 'viem'
import { useAuth } from '@/context/AuthContext'
import { useAgents, type AgentStatus } from '@/hooks/useAgents'
import { useAgentActivity } from '@/hooks/useAgentActivity'
import { useOnChainAllowances } from '@/hooks/useOnChainAllowances'
import { useSafeDetails } from '@/hooks/useSafeDetails'
import { RESET_PERIODS } from '@/lib/allowance-module'
import { getChainConfig, getExplorerUrl } from '@/lib/chains'
import { truncate, timeAgo } from '@/lib/format'
import { isUserRejectedError, revokeAgentOnChain } from '@/lib/revoke-agent'
import EditAgentModal from '@/components/EditAgentModal'
import ConfirmDialog from '@/components/ConfirmDialog'

function statusLabel(status: AgentStatus | string): string {
  if (status === 'active') return 'Connected'
  if (status === 'paused') return 'Paused'
  if (status === 'revoked') return 'Revoked'
  return status
}

function statusClasses(status: AgentStatus | string): string {
  if (status === 'active') return 'bg-emerald-500/10 text-emerald-400'
  if (status === 'paused') return 'bg-amber-500/10 text-amber-300'
  if (status === 'revoked') return 'bg-red-500/10 text-red-300'
  return 'bg-white/[0.06] text-zinc-500'
}

function formatAllowanceAmount(amount: string, decimals: number): string {
  try {
    const raw = BigInt(amount)
    const divisor = 10n ** BigInt(decimals)
    const whole = raw / divisor
    const fraction = raw % divisor
    const fractionText = fraction
      .toString()
      .padStart(decimals, '0')
      .slice(0, 4)
      .replace(/0+$/, '')

    return fractionText ? `${whole}.${fractionText}` : whole.toString()
  } catch {
    return amount
  }
}

function resetLabel(resetPeriodMin: number): string {
  return RESET_PERIODS.find((item) => item.value === resetPeriodMin)?.label ?? `${resetPeriodMin}m`
}

function StatBlock({
  label,
  value,
  helper,
}: {
  label: string
  value: string
  helper?: string
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <p className="text-xs uppercase tracking-wide text-zinc-600">{label}</p>
      <p className="mt-3 text-2xl font-semibold tracking-tight text-zinc-100">{value}</p>
      {helper ? <p className="mt-2 text-xs text-zinc-500">{helper}</p> : null}
    </div>
  )
}

interface Props {
  agentId: string
}

type PendingAction = 'pause' | 'resume' | 'revoke' | 'delete' | null
type ConfirmAction = 'revoke' | 'delete' | null

export default function AgentDetailClient({ agentId }: Props) {
  const router = useRouter()
  const { user } = useAuth()
  const { agents, loading, pauseAgent, resumeAgent, revokeAgent, deleteAgent, refetch } = useAgents()
  const agent = agents.find((item) => item.id === agentId) ?? null
  const safe = useMemo(
    () => user?.safes.find((item) => item.id === agent?.safe_id) ?? null,
    [agent?.safe_id, user?.safes],
  )
  const safeAddress = safe?.safe_address ?? agent?.safe_address ?? null
  const chainId = safe?.chain_id ?? 100
  const chainConfig = safe ? getChainConfig(safe.chain_id) : null
  const { details: safeDetails } = useSafeDetails(safeAddress)
  const { activity, stats, loading: activityLoading } = useAgentActivity(agent?.id ?? null)
  const managedDelegates = useMemo(
    () => (agent?.delegate_address && agent.status !== 'revoked' ? [agent.delegate_address] : []),
    [agent?.delegate_address, agent?.status],
  )
  const { data: onChainData, refetch: refetchOnChain } = useOnChainAllowances(
    safeAddress,
    managedDelegates,
    chainId,
  )
  const delegateKey = agent?.delegate_address?.toLowerCase() ?? ''
  const existingOnChainAllowances = delegateKey
    ? onChainData.get(delegateKey)?.allowances ?? null
    : null

  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()
  const { address: connectedAddress } = useAccount()

  const [editOpen, setEditOpen] = useState(false)
  const [pendingAction, setPendingAction] = useState<PendingAction>(null)
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const isActive = agent?.status === 'active'
  const isPaused = agent?.status === 'paused'
  const isRevoked = agent?.status === 'revoked'

  if (loading) {
    return (
      <div className="max-w-5xl">
        <div className="space-y-4">
          <div className="h-6 w-40 rounded bg-white/[0.06] animate-pulse" />
          <div className="h-24 rounded-xl bg-white/[0.04] animate-pulse" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[0, 1, 2].map((index) => (
              <div key={index} className="h-28 rounded-xl bg-white/[0.04] animate-pulse" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (!agent) {
    return (
      <div className="max-w-3xl">
        <Link href="/agents" className="text-sm font-medium text-indigo-300 hover:text-indigo-200 transition-colors">
          ← Back to Agents
        </Link>
        <div className="mt-6 rounded-xl border border-white/[0.06] bg-white/[0.02] p-8 text-center">
          <h1 className="text-xl font-semibold text-zinc-100">Agent not found</h1>
          <p className="mt-2 text-sm text-zinc-500">
            This agent may have been removed or you may no longer have access to it.
          </p>
        </div>
      </div>
    )
  }

  const currentAgent = agent

  async function handlePause() {
    setPendingAction('pause')
    setErrorMessage(null)
    try {
      await pauseAgent(currentAgent.id)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Pause failed')
    } finally {
      setPendingAction(null)
    }
  }

  async function handleResume() {
    setPendingAction('resume')
    setErrorMessage(null)
    try {
      await resumeAgent(currentAgent.id)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Resume failed')
    } finally {
      setPendingAction(null)
    }
  }

  async function handleDelete() {
    setPendingAction('delete')
    setErrorMessage(null)
    try {
      await deleteAgent(currentAgent.id)
      router.push('/agents')
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setPendingAction(null)
      setConfirmAction(null)
    }
  }

  async function handleRevoke() {
    if (
      !publicClient ||
      !walletClient ||
      !connectedAddress ||
      !safeAddress ||
      !safeDetails
    ) {
      setErrorMessage('Connect your wallet and reload Safe details before revoking this agent.')
      return
    }

    setPendingAction('revoke')
    setErrorMessage(null)
    try {
      await revokeAgentOnChain({
        agent: currentAgent,
        publicClient,
        walletClient,
        connectedAddress,
        safeAddress: safeAddress as Address,
        safeDetails,
        chainId,
      })
      await revokeAgent(currentAgent.id)
      await refetch()
      await refetchOnChain()
    } catch (err) {
      if (!isUserRejectedError(err)) {
        setErrorMessage(err instanceof Error ? err.message : 'Revoke failed')
      }
    } finally {
      setPendingAction(null)
      setConfirmAction(null)
    }
  }

  return (
    <div className="max-w-5xl">
      <Link href="/agents" className="text-sm font-medium text-indigo-300 hover:text-indigo-200 transition-colors">
        ← Back to Agents
      </Link>

      <div className="mt-5 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">{currentAgent.name}</h1>
              <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusClasses(currentAgent.status)}`}>
                {statusLabel(currentAgent.status)}
              </span>
            </div>
            {currentAgent.description ? (
              <p className="mt-3 text-sm text-zinc-400 max-w-2xl">{currentAgent.description}</p>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-4 text-sm text-zinc-500">
              <span>Account: <span className="text-zinc-300">{currentAgent.safe_name ?? safe?.name ?? 'Unassigned'}</span></span>
              {chainConfig ? <span>Network: <span className="text-zinc-300">{chainConfig.name}</span></span> : null}
              <span>Recipients: <span className="text-zinc-300">Any recipient</span></span>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            {!isRevoked ? (
              <button
                onClick={() => setEditOpen(true)}
                disabled={pendingAction !== null}
                className="inline-flex items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03] px-4 py-2.5 text-sm font-medium text-zinc-200 hover:bg-white/[0.06] disabled:opacity-50 transition-colors"
              >
                Edit
              </button>
            ) : null}
            {isActive ? (
              <button
                onClick={() => void handlePause()}
                disabled={pendingAction !== null}
                className="inline-flex items-center justify-center rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-2.5 text-sm font-medium text-amber-200 hover:bg-amber-500/15 disabled:opacity-50 transition-colors"
              >
                {pendingAction === 'pause' ? 'Pausing...' : 'Pause'}
              </button>
            ) : null}
            {isPaused ? (
              <button
                onClick={() => void handleResume()}
                disabled={pendingAction !== null}
                className="inline-flex items-center justify-center rounded-lg bg-gradient-to-r from-indigo-500 to-violet-600 px-4 py-2.5 text-sm font-medium text-white hover:from-indigo-400 hover:to-violet-500 disabled:opacity-50 transition-all duration-200 shadow-lg shadow-indigo-500/20"
              >
                {pendingAction === 'resume' ? 'Resuming...' : 'Resume from pause'}
              </button>
            ) : null}
            {!isRevoked ? (
              <button
                onClick={() => setConfirmAction('revoke')}
                disabled={pendingAction !== null}
                className="inline-flex items-center justify-center rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-2.5 text-sm font-medium text-red-200 hover:bg-red-500/15 disabled:opacity-50 transition-colors"
              >
                Revoke
              </button>
            ) : (
              <button
                onClick={() => setConfirmAction('delete')}
                disabled={pendingAction !== null}
                className="inline-flex items-center justify-center rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-2.5 text-sm font-medium text-red-200 hover:bg-red-500/15 disabled:opacity-50 transition-colors"
              >
                Delete
              </button>
            )}
            {currentAgent.delegate_address && chainConfig ? (
              <a
                href={getExplorerUrl(chainId, 'address', currentAgent.delegate_address)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03] px-4 py-2.5 text-sm font-medium text-zinc-200 hover:bg-white/[0.06] transition-colors"
              >
                View delegate
              </a>
            ) : null}
          </div>
        </div>
      </div>

      {isPaused ? (
        <div className="mt-4 rounded-xl border border-amber-500/15 bg-amber-500/5 px-4 py-3">
          <p className="text-sm font-medium text-amber-200">Paused in Haven</p>
          <p className="mt-1 text-sm text-amber-100/75">
            New API-initiated transactions are blocked until you resume this agent. On-chain delegate access and allowances are still in place.
          </p>
        </div>
      ) : null}

      {errorMessage ? (
        <div className="mt-4 rounded-xl border border-red-500/15 bg-red-500/5 px-4 py-3">
          <p className="text-sm font-medium text-red-200">Action failed</p>
          <p className="mt-1 text-sm text-red-100/75">{errorMessage}</p>
        </div>
      ) : null}

      <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatBlock
          label="All-time transactions"
          value={stats ? String(stats.all_time.reduce((sum, item) => sum + item.tx_count, 0)) : '0'}
          helper="Confirmed agent payments"
        />
        <StatBlock
          label="Today"
          value={stats ? String(stats.today.reduce((sum, item) => sum + item.tx_count, 0)) : '0'}
          helper="Payments started today"
        />
        <StatBlock
          label="Pending approvals"
          value={stats ? String(stats.pending_approvals) : '0'}
          helper="Payments waiting on you"
        />
      </div>

      <div className="mt-6 grid grid-cols-1 xl:grid-cols-[1.1fr_0.9fr] gap-6">
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
          <div className="px-5 py-4 border-b border-white/[0.06]">
            <h2 className="text-sm font-semibold text-zinc-100">Spending limits</h2>
          </div>
          {currentAgent.allowances.length === 0 ? (
            <div className="p-6 text-center">
              <p className="text-sm text-zinc-300">No spend limits configured</p>
              {!isRevoked ? (
                <button
                  onClick={() => setEditOpen(true)}
                  className="mt-3 text-xs font-medium text-indigo-300 hover:text-indigo-200 transition-colors"
                >
                  Add a spend limit in Edit
                </button>
              ) : (
                <p className="mt-2 text-xs text-zinc-500">This agent can no longer be edited because it has been revoked.</p>
              )}
            </div>
          ) : (
            <div className="divide-y divide-white/[0.06]">
              {currentAgent.allowances.map((allowance) => {
                const decimals =
                  chainConfig &&
                  Object.values(chainConfig.tokens).find((token) => token.symbol === allowance.token_symbol)?.decimals

                return (
                  <div key={allowance.id} className="px-5 py-4">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-sm font-medium text-zinc-100">{allowance.token_symbol}</p>
                        <p className="mt-1 text-xs text-zinc-500">
                          Resets: {resetLabel(allowance.reset_period_min)}
                        </p>
                      </div>
                      <p className="text-sm font-medium text-zinc-200">
                        {formatAllowanceAmount(allowance.allowance_amount, decimals ?? 18)} {allowance.token_symbol}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
          <div className="px-5 py-4 border-b border-white/[0.06]">
            <h2 className="text-sm font-semibold text-zinc-100">Delegate</h2>
          </div>
          <div className="p-5">
            {currentAgent.delegate_address ? (
              <>
                <p className="text-xs uppercase tracking-wide text-zinc-600">Delegate address</p>
                <code className="mt-3 block text-sm text-zinc-200 break-all">{currentAgent.delegate_address}</code>
                <p className="mt-4 text-xs text-zinc-500">
                  If this delegate is ever compromised, revoke this agent and create a new one.
                </p>
              </>
            ) : (
              <p className="text-sm text-zinc-500">This agent does not currently expose a delegate address.</p>
            )}
          </div>
        </div>
      </div>

      <div className="mt-6 rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
        <div className="px-5 py-4 border-b border-white/[0.06]">
          <h2 className="text-sm font-semibold text-zinc-100">Recent activity</h2>
        </div>

        {activityLoading ? (
          <div className="p-5 space-y-3">
            {[0, 1, 2].map((index) => (
              <div key={index} className="h-14 rounded-lg bg-white/[0.04] animate-pulse" />
            ))}
          </div>
        ) : activity.length === 0 ? (
          <div className="p-6 text-center">
            <p className="text-sm text-zinc-300">No activity yet</p>
            <p className="mt-2 text-xs text-zinc-500">Payments, approvals, and confirmations for this agent will appear here.</p>
          </div>
        ) : (
          <div className="divide-y divide-white/[0.06]">
            {activity.map((item) => (
              <div key={`${item.type}-${item.id}`} className="flex items-center justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-zinc-100">
                      {item.amount} {item.token}
                    </p>
                    <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${statusClasses(item.status)}`}>
                      {statusLabel(item.status)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500 truncate">
                    {item.type === 'approval' ? 'Approval' : 'Payment'} to {truncate(item.to)}
                    {item.reason ? ` • ${item.reason}` : ''}
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  {item.tx_hash && item.explorer_url ? (
                    <a
                      href={item.explorer_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-medium text-indigo-300 hover:text-indigo-200 transition-colors"
                    >
                      View tx
                    </a>
                  ) : null}
                  <p className="mt-1 text-xs text-zinc-500">{timeAgo(item.created_at)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmAction === 'revoke'}
        onCancel={() => setConfirmAction(null)}
        onConfirm={handleRevoke}
        title="Revoke this agent?"
        body="This removes the delegate's ability to spend through Haven. On-chain access will be revoked, and the agent will need a new setup if you want to use it again."
        confirmLabel="Revoke agent"
        loading={pendingAction === 'revoke'}
      />

      <ConfirmDialog
        open={confirmAction === 'delete'}
        onCancel={() => setConfirmAction(null)}
        onConfirm={handleDelete}
        title="Delete this revoked agent?"
        body="This removes the revoked agent from your Haven dashboard. This does not restore access or recreate credentials."
        confirmLabel="Delete agent"
        loading={pendingAction === 'delete'}
      />

      {!isRevoked ? (
        <EditAgentModal
          open={editOpen}
          onClose={() => setEditOpen(false)}
          agent={currentAgent}
          safeAddress={safeAddress ?? ''}
          safeDetails={safeDetails}
          existingOnChainAllowances={existingOnChainAllowances}
          onUpdated={() => {
            refetch()
            setEditOpen(false)
            void refetchOnChain()
          }}
        />
      ) : null}
    </div>
  )
}
