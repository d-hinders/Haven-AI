'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { usePublicClient } from 'wagmi'
import { type Address } from 'viem'
import { useAuth } from '@/context/AuthContext'
import { useAgents, type AgentStatus } from '@/hooks/useAgents'
import { useAgentActivity } from '@/hooks/useAgentActivity'
import { useOnChainAllowances } from '@/hooks/useOnChainAllowances'
import { useSafeOperationGate } from '@/hooks/useSafeOperationGate'
import { useSafeDetails } from '@/hooks/useSafeDetails'
import { RESET_PERIODS } from '@/lib/allowance-module'
import { getChainConfig } from '@/lib/chains'
import { truncate, timeAgo } from '@/lib/format'
import { isUserRejectedError, revokeAgentOnChain } from '@/lib/revoke-agent'
import { useActiveSigner } from '@/lib/signer'
import EditAgentModal from '@/components/EditAgentModal'
import ConfirmDialog from '@/components/ConfirmDialog'
import PasskeyOtherDeviceNotice from '@/components/PasskeyOtherDeviceNotice'
import { Button } from '@/components/ui/Button'

function statusLabel(status: AgentStatus | string): string {
  if (status === 'active') return 'Connected'
  if (status === 'paused') return 'Paused'
  if (status === 'revoked') return 'Revoked'
  return status
}

function statusClasses(status: AgentStatus | string): string {
  if (status === 'active') return 'bg-[var(--v2-success-soft)] text-[var(--v2-success)]'
  if (status === 'paused') return 'bg-[var(--v2-warning-soft)] text-[var(--v2-warning)]'
  if (status === 'revoked') return 'bg-[var(--v2-danger-soft)] text-[var(--v2-danger)]'
  return 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-3)]'
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
    <div className="rounded-[10px] border border-[var(--v2-border)] bg-white p-4 shadow-[var(--v2-shadow-card)]">
      <p className="text-xs uppercase tracking-wide text-[var(--v2-ink-3)]">{label}</p>
      <p className="mt-3 text-2xl font-semibold tracking-tight text-[var(--v2-ink)]">{value}</p>
      {helper ? <p className="mt-2 text-xs text-[var(--v2-ink-2)]">{helper}</p> : null}
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

  const publicClient = usePublicClient({ chainId })
  const signer = useActiveSigner({
    safeAddress: safeAddress ? (safeAddress as Address) : undefined,
    chainId,
  })
  const operationGate = useSafeOperationGate({
    safeAddress: safeAddress ? (safeAddress as Address) : undefined,
    chainId,
  })
  const revokeBlockedByOtherDevice = operationGate.kind === 'passkey_on_other_device'

  const [editOpen, setEditOpen] = useState(false)
  const [pendingAction, setPendingAction] = useState<PendingAction>(null)
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [showCredential, setShowCredential] = useState(false)
  const [credentialCopied, setCredentialCopied] = useState(false)

  const isActive = agent?.status === 'active'
  const isPaused = agent?.status === 'paused'
  const isRevoked = agent?.status === 'revoked'

  if (loading) {
    return (
      <div className="max-w-5xl">
        <div className="space-y-4">
          <div className="h-6 w-40 rounded bg-[var(--v2-surface-2)] animate-pulse" />
          <div className="h-24 rounded-xl bg-[var(--v2-surface-2)] animate-pulse" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[0, 1, 2].map((index) => (
              <div key={index} className="h-28 rounded-xl bg-[var(--v2-surface-2)] animate-pulse" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (!agent) {
    return (
      <div className="max-w-3xl">
        <Link href="/agents" className="text-sm font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors">
          ← Back to Agents
        </Link>
        <div className="mt-6 rounded-[10px] border border-[var(--v2-border)] bg-white p-8 text-center shadow-[var(--v2-shadow-card)]">
          <h1 className="text-xl font-semibold text-[var(--v2-ink)]">Agent not found</h1>
          <p className="mt-2 text-sm text-[var(--v2-ink-2)]">
            This agent may have been removed or you may no longer have access to it.
          </p>
        </div>
      </div>
    )
  }

  const currentAgent = agent

  function copyCredential() {
    navigator.clipboard.writeText(currentAgent.api_key)
    setCredentialCopied(true)
    setTimeout(() => setCredentialCopied(false), 2000)
  }

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
    if (revokeBlockedByOtherDevice) {
      setErrorMessage(null)
      return
    }

    if (
      !publicClient ||
      !signer ||
      !safeAddress ||
      !safeDetails
    ) {
      setErrorMessage('Connect your wallet and reload account details before revoking this agent.')
      return
    }

    setPendingAction('revoke')
    setErrorMessage(null)
    try {
      await revokeAgentOnChain({
        agent: currentAgent,
        publicClient,
        signer,
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
      <Link href="/agents" className="text-sm font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors">
        ← Back to Agents
      </Link>

      <div className="relative mt-5 overflow-hidden rounded-[24px] border border-[#E7E9F2] bg-[#F7F5FF] shadow-[0_10px_24px_-22px_rgba(16,24,40,0.18)]">
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'linear-gradient(90deg, #F7F5FF 0%, #F3F0FF 55%, #F8F6FF 100%)',
          }}
        />
        <div className="relative flex flex-col gap-5 p-6 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight text-[var(--v2-ink)]">{currentAgent.name}</h1>
              <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusClasses(currentAgent.status)}`}>
                {statusLabel(currentAgent.status)}
              </span>
            </div>
            {currentAgent.description ? (
              <p className="mt-3 text-sm text-[var(--v2-ink-2)] max-w-2xl">{currentAgent.description}</p>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-4 text-sm text-[var(--v2-ink-3)]">
              <span>Account: <span className="text-[var(--v2-ink)]">{currentAgent.safe_name ?? safe?.name ?? 'Unassigned'}</span></span>
              {chainConfig ? <span>Network: <span className="text-[var(--v2-ink)]">{chainConfig.name}</span></span> : null}
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            {!isRevoked ? (
              <Button
                onClick={() => setEditOpen(true)}
                disabled={pendingAction !== null}
                variant="ghost"
              >
                Edit
              </Button>
            ) : null}
            {isActive ? (
              <Button
                onClick={() => void handlePause()}
                disabled={pendingAction !== null}
                variant="ghost"
              >
                {pendingAction === 'pause' ? 'Pausing...' : 'Pause'}
              </Button>
            ) : null}
            {isPaused ? (
              <Button
                onClick={() => void handleResume()}
                disabled={pendingAction !== null}
              >
                {pendingAction === 'resume' ? 'Resuming...' : 'Resume from pause'}
              </Button>
            ) : null}
            {!isRevoked ? (
              <Button
                onClick={() => setConfirmAction('revoke')}
                disabled={pendingAction !== null || revokeBlockedByOtherDevice}
                variant="danger"
              >
                Revoke
              </Button>
            ) : (
              <Button
                onClick={() => setConfirmAction('delete')}
                disabled={pendingAction !== null}
                variant="danger"
              >
                Delete
              </Button>
            )}
          </div>
        </div>
      </div>

      {revokeBlockedByOtherDevice ? (
        <PasskeyOtherDeviceNotice className="mt-4" />
      ) : null}

      {isPaused ? (
        <div className="mt-4 rounded-xl border border-[var(--v2-warning)]/20 bg-[var(--v2-warning-soft)] px-4 py-3">
          <p className="text-sm font-medium text-[var(--v2-warning)]">Paused in Haven</p>
          <p className="mt-1 text-sm text-[var(--v2-warning)]">
            New agent payments are blocked until you resume this agent. Existing network permissions stay in place.
          </p>
        </div>
      ) : null}

      {errorMessage ? (
        <div className="mt-4 rounded-xl border border-[var(--v2-danger)]/20 bg-[var(--v2-danger-soft)] px-4 py-3">
          <p className="text-sm font-medium text-[var(--v2-danger)]">Action failed</p>
          <p className="mt-1 text-sm text-[var(--v2-danger)]">{errorMessage}</p>
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
        <div className="rounded-[10px] border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-card)] overflow-hidden">
          <div className="px-5 py-4 border-b border-[var(--v2-border)]">
            <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Agent budget</h2>
          </div>
          {currentAgent.allowances.length === 0 ? (
            <div className="p-6 text-center">
              <p className="text-sm text-[var(--v2-ink)]">No agent budget configured</p>
              {!isRevoked ? (
                <button
                  onClick={() => setEditOpen(true)}
                  className="mt-3 text-xs font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors"
                >
                  Add a spend limit in Edit
                </button>
              ) : (
                <p className="mt-2 text-xs text-[var(--v2-ink-2)]">This agent can no longer be edited because it has been revoked.</p>
              )}
            </div>
          ) : (
            <div className="divide-y divide-[var(--v2-border)]">
              {currentAgent.allowances.map((allowance) => {
                const decimals =
                  chainConfig &&
                  Object.values(chainConfig.tokens).find((token) => token.symbol === allowance.token_symbol)?.decimals

                return (
                  <div key={allowance.id} className="px-5 py-4">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-sm font-medium text-[var(--v2-ink)]">{allowance.token_symbol}</p>
                        <p className="mt-1 text-xs text-[var(--v2-ink-2)]">
                          Resets: {resetLabel(allowance.reset_period_min)}
                        </p>
                      </div>
                      <p className="text-sm font-medium text-[var(--v2-ink)]">
                        {formatAllowanceAmount(allowance.allowance_amount, decimals ?? 18)} {allowance.token_symbol}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="space-y-6">
          {!isRevoked ? (
            <div className="rounded-[10px] border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-card)] overflow-hidden">
              <div className="px-5 py-4 border-b border-[var(--v2-border)]">
                <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Haven credential</h2>
              </div>
              <div className="p-5">
                <p className="text-sm text-[var(--v2-ink-2)]">
                  Add this credential to your agent so it can make payments within the rules you set.
                </p>
                <div className="mt-4 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] px-3 py-2 text-xs font-mono text-[var(--v2-ink-2)]">
                    {showCredential ? currentAgent.api_key : `sk_agent_${'*'.repeat(16)}`}
                  </code>
                  <button
                    onClick={() => setShowCredential((value) => !value)}
                    className="text-xs font-medium text-[var(--v2-ink-3)] transition-colors hover:text-[var(--v2-ink)]"
                  >
                    {showCredential ? 'Hide' : 'Show'}
                  </button>
                  <button
                    onClick={copyCredential}
                    className="text-xs font-medium text-[var(--v2-brand)] transition-colors hover:text-[var(--v2-brand-strong)]"
                  >
                    {credentialCopied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          <div className="rounded-[10px] border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-card)] overflow-hidden">
            <div className="px-5 py-4 border-b border-[var(--v2-border)]">
              <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Delegate</h2>
            </div>
            <div className="p-5">
              {currentAgent.delegate_address ? (
                <>
                  <p className="text-xs uppercase tracking-wide text-[var(--v2-ink-3)]">Delegate address</p>
                  <code className="mt-3 block text-sm text-[var(--v2-ink)] break-all">{currentAgent.delegate_address}</code>
                  <p className="mt-4 text-xs text-[var(--v2-ink-2)]">
                    If this delegate is ever compromised, revoke this agent and create a new one.
                  </p>
                </>
              ) : (
                <p className="text-sm text-[var(--v2-ink-2)]">This agent does not currently expose a delegate address.</p>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-6 rounded-[10px] border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-card)] overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--v2-border)]">
          <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Recent activity</h2>
        </div>

        {activityLoading ? (
          <div className="p-5 space-y-3">
            {[0, 1, 2].map((index) => (
              <div key={index} className="h-14 rounded-lg bg-[var(--v2-surface-2)] animate-pulse" />
            ))}
          </div>
        ) : activity.length === 0 ? (
          <div className="p-6 text-center">
            <p className="text-sm text-[var(--v2-ink)]">No activity yet</p>
            <p className="mt-2 text-xs text-[var(--v2-ink-2)]">Payments, approvals, and confirmations for this agent will appear here.</p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--v2-border)]">
            {activity.map((item) => (
              <div key={`${item.type}-${item.id}`} className="flex items-center justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-[var(--v2-ink)]">
                      {item.amount} {item.token}
                    </p>
                    <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${statusClasses(item.status)}`}>
                      {statusLabel(item.status)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-[var(--v2-ink-2)] truncate">
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
                      className="text-xs font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors"
                    >
                      View tx
                    </a>
                  ) : null}
                  <p className="mt-1 text-xs text-[var(--v2-ink-2)]">{timeAgo(item.created_at)}</p>
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
        body="This removes the agent's ability to spend through Haven. Network access will be revoked, and the agent will need a new setup if you want to use it again."
        confirmLabel="Revoke agent"
        loading={pendingAction === 'revoke'}
      />

      <ConfirmDialog
        open={confirmAction === 'delete'}
        onCancel={() => setConfirmAction(null)}
        onConfirm={handleDelete}
        title="Delete this revoked agent?"
        body="This removes the revoked agent from your Haven dashboard. It does not restore access or recreate the setup."
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
