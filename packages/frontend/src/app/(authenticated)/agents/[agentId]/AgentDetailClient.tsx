'use client'

import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { usePublicClient } from 'wagmi'
import { type Address } from 'viem'
import { useAuth } from '@/context/AuthContext'
import { useAgents, type AgentStatus } from '@/hooks/useAgents'
import { useAgentActivity, type ActivityItem } from '@/hooks/useAgentActivity'
import { useOnChainAllowances } from '@/hooks/useOnChainAllowances'
import { useSafeOperationGate } from '@/hooks/useSafeOperationGate'
import { useSafeDetails } from '@/hooks/useSafeDetails'
import { RESET_PERIODS } from '@/lib/allowance-module'
import { getChainConfig } from '@/lib/chains'
import { parseX402Hostname } from '@/lib/transaction-labels'
import { truncate, timeAgo } from '@/lib/format'
import { isUserRejectedError, revokeAgentOnChain } from '@/lib/revoke-agent'
import { useActiveSigner } from '@/lib/signer'
import EditAgentModal from '@/components/EditAgentModal'
import ConfirmDialog from '@/components/ConfirmDialog'
import PasskeyOtherDeviceNotice from '@/components/PasskeyOtherDeviceNotice'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { StatusBadge } from '@/components/ui/StatusBadge'
import {
  AgentActivityRow,
  AgentBudgetCard,
  AgentRulesSummary,
  ApprovalRequiredBanner,
  ExternalDetailsLink,
  TransactionMovement,
} from '@/components/haven'

function statusLabel(status: AgentStatus | string): string {
  if (status === 'active') return 'Connected'
  if (status === 'paused') return 'Paused'
  if (status === 'revoked') return 'Revoked'
  return status
}

function statusTone(status: AgentStatus | string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'active') return 'success'
  if (status === 'paused') return 'warning'
  if (status === 'revoked') return 'danger'
  return 'neutral'
}

function activityStatusLabel(status: string): string {
  if (status === 'confirmed' || status === 'executed') return 'Sent'
  if (status === 'pending' || status === 'pending_approval') return 'Needs approval'
  if (status === 'failed') return 'Failed'
  if (status === 'rejected') return 'Rejected'
  return statusLabel(status)
}

function activityStatusTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'confirmed' || status === 'executed') return 'neutral'
  if (status === 'pending' || status === 'pending_approval') return 'warning'
  if (status === 'failed' || status === 'rejected') return 'danger'
  return 'neutral'
}

function activityTitle(item: ActivityItem, agentName?: string): string {
  if (item.source === 'x402') {
    return agentName ? `x402 payment by ${agentName}` : 'x402 payment'
  }
  if (item.type === 'approval') return 'Approval request'
  if (item.status === 'failed') return 'Payment failed'
  if (item.status === 'rejected') return 'Payment rejected'
  return 'Agent payment'
}

function activityMovement(item: ActivityItem, walletName: string) {
  const recipient = item.source === 'x402'
    ? parseX402Hostname(item.x402_resource_url) ?? truncate(item.to)
    : truncate(item.to)

  return <TransactionMovement from={walletName} to={recipient} />
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

function budgetPeriodLabel(resetPeriodMin: number): string {
  const label = resetLabel(resetPeriodMin).toLowerCase()
  if (label === 'one-time') return 'total budget'
  if (label === 'daily') return 'per day'
  if (label === 'weekly') return 'per week'
  if (label === 'monthly') return 'per month'
  return `every ${label}`
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
    <Card hover={false} className="p-4">
      <p className="text-xs font-medium text-[var(--v2-ink-3)]">{label}</p>
      <p className="mt-3 text-2xl font-semibold tracking-tight text-[var(--v2-ink)] v2-tabular">{value}</p>
      {helper ? <p className="mt-2 text-xs text-[var(--v2-ink-2)]">{helper}</p> : null}
    </Card>
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
  const [delegateCopied, setDelegateCopied] = useState(false)

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
        <div className="rounded-[10px] border border-[var(--v2-border)] bg-white p-8 text-center shadow-[var(--v2-shadow-card)]">
          <h1 className="text-xl font-semibold text-[var(--v2-ink)]">Agent not found</h1>
          <p className="mt-2 text-sm text-[var(--v2-ink-2)]">
            This agent may have been removed or you may no longer have access to it.
          </p>
        </div>
      </div>
    )
  }

  const currentAgent = agent
  const fullCredential = currentAgent.api_key?.trim() || null
  const credentialPrefix =
    currentAgent.api_key_prefix ?? (fullCredential ? fullCredential.slice(0, 12) : null)
  const maskedCredential = credentialPrefix
    ? `${credentialPrefix}${'•'.repeat(12)}`
    : 'Credential shown only when created'
  const walletName = currentAgent.safe_name ?? safe?.name ?? 'Unassigned Haven wallet'
  const networkName = chainConfig?.name ?? 'Unknown network'
  const budgetLines = currentAgent.allowances.map((allowance) => {
    const decimals =
      chainConfig &&
      Object.values(chainConfig.tokens).find((token) => token.symbol === allowance.token_symbol)?.decimals
    const amount = formatAllowanceAmount(allowance.allowance_amount, decimals ?? 18)
    return {
      id: allowance.id,
      label: `${amount} ${allowance.token_symbol} ${budgetPeriodLabel(allowance.reset_period_min)}`,
      token: allowance.token_symbol,
      amount,
      period: budgetPeriodLabel(allowance.reset_period_min),
    }
  })
  const budgetAmountSummary =
    budgetLines.length === 0
      ? 'No budget set'
      : budgetLines.length === 1
        ? `${budgetLines[0].amount} ${budgetLines[0].token}`
        : `${budgetLines.length} budgets set`
  const budgetPeriodSummary =
    budgetLines.length === 0
      ? 'Add an agent budget'
      : budgetLines.length === 1
        ? budgetLines[0].period
        : budgetLines.map((line) => line.label).join(' • ')
  const approvalCopy =
    budgetLines.length === 0
      ? 'No automatic spending is configured for this agent.'
      : 'Payments within budget can run automatically. Larger payments need your manual approval.'

  async function copyCredential() {
    if (!fullCredential) return
    await navigator.clipboard.writeText(fullCredential)
    setCredentialCopied(true)
    setTimeout(() => setCredentialCopied(false), 2000)
  }

  async function copyDelegateAddress() {
    if (!currentAgent.delegate_address) return
    await navigator.clipboard.writeText(currentAgent.delegate_address)
    setDelegateCopied(true)
    setTimeout(() => setDelegateCopied(false), 2000)
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
    <div className="mx-auto max-w-6xl">
      <Card hover={false} className="p-5 md:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight text-[var(--v2-ink)]">{currentAgent.name}</h1>
              <StatusBadge tone={statusTone(currentAgent.status)}>
                {statusLabel(currentAgent.status)}
              </StatusBadge>
            </div>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--v2-ink-2)]">
              {currentAgent.description || 'This agent can make payments within the rules you set.'}
            </p>
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs font-medium text-[var(--v2-ink-3)]">Haven wallet</dt>
                <dd className="mt-1 font-medium text-[var(--v2-ink)]">{walletName}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--v2-ink-3)]">Network</dt>
                <dd className="mt-1 font-medium text-[var(--v2-ink)]">{networkName}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--v2-ink-3)]">Created</dt>
                <dd className="mt-1 font-medium text-[var(--v2-ink)]">{timeAgo(currentAgent.created_at)}</dd>
              </div>
            </dl>
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
      </Card>

      {revokeBlockedByOtherDevice ? (
        <PasskeyOtherDeviceNotice className="mt-4" />
      ) : null}

      {isPaused ? (
        <div className="mt-4">
          <ApprovalRequiredBanner title="Paused in Haven" tone="neutral" density="compact">
            New agent payments are blocked until you resume this agent. Existing wallet rules stay in place.
          </ApprovalRequiredBanner>
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

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <AgentRulesSummary
            title="Agent rules"
            description="A quick view of what this agent can do and how you stay in control."
            items={[
              {
                label: 'Who can spend',
                value: currentAgent.name,
                helper: currentAgent.description || undefined,
              },
              {
                label: 'From wallet',
                value: `${walletName} on ${networkName}`,
                helper: 'Payments come from this Haven wallet only.',
              },
              {
                label: 'Agent budget',
                value:
                  budgetLines.length > 0 ? (
                    <div className="space-y-1">
                      {budgetLines.map((line) => (
                        <div key={line.id}>{line.label}</div>
                      ))}
                    </div>
                  ) : (
                    'No budget set'
                ),
                helper: approvalCopy,
              },
            ]}
          />

          {budgetLines.length > 0 ? (
            <AgentBudgetCard
              agentName={currentAgent.name}
              walletName={walletName}
              amount={budgetAmountSummary}
              resetPeriod={budgetPeriodSummary}
              status={statusLabel(currentAgent.status)}
              statusTone={statusTone(currentAgent.status)}
              density="compact"
            >
              <div className="space-y-2">
                {budgetLines.map((line) => (
                  <div key={line.id} className="flex items-center justify-between gap-3 rounded-lg border border-[var(--v2-border)] bg-white px-3 py-2">
                    <p className="text-sm font-medium text-[var(--v2-ink)] v2-tabular">{line.amount} {line.token}</p>
                    <p className="text-xs text-[var(--v2-ink-2)]">{line.period}</p>
                  </div>
                ))}
              </div>
            </AgentBudgetCard>
          ) : (
            <EmptyState
              title="No agent budget set"
              body={isRevoked ? 'This agent has been revoked and can no longer be edited.' : 'Add an agent budget before this agent can make automatic payments.'}
              action={!isRevoked ? <Button size="sm" onClick={() => setEditOpen(true)}>Add budget</Button> : undefined}
            />
          )}

          <Card hover={false} className="overflow-hidden">
            <div className="border-b border-[var(--v2-border)] bg-[var(--v2-surface)] px-5 py-4">
              <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Recent activity</h2>
              <p className="mt-1 text-xs text-[var(--v2-ink-2)]">Payments and approval requests from this agent.</p>
            </div>

            {activityLoading ? (
              <div className="p-5 space-y-3">
                {[0, 1, 2].map((index) => (
                  <div key={index} className="h-14 rounded-lg bg-[var(--v2-surface-2)] animate-pulse" />
                ))}
              </div>
            ) : activity.length === 0 ? (
              <EmptyState
                className="m-5"
                title="No activity yet"
                body="Payments, approvals, and confirmations for this agent will appear here."
              />
            ) : (
              <div>
                {activity.map((item) => (
                  <AgentActivityRow
                    key={`${item.type}-${item.id}`}
                    title={activityTitle(item, currentAgent.name)}
                    description={activityMovement(item, walletName)}
                    amount={`-${item.amount} ${item.token}`}
                    amountTone={item.status === 'failed' || item.status === 'rejected' ? 'danger' : 'neutral'}
                    status={activityStatusLabel(item.status)}
                    statusTone={activityStatusTone(item.status)}
                    timestamp={timeAgo(item.created_at)}
                    action={
                      item.tx_hash && item.explorer_url ? (
                        <ExternalDetailsLink href={item.explorer_url} />
                      ) : undefined
                    }
                  />
                ))}
              </div>
            )}
          </Card>
        </div>

        <aside className="space-y-6">
          <Card hover={false} className="p-5">
            <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Agent access</h2>
            <p className="mt-2 text-sm leading-relaxed text-[var(--v2-ink-2)]">
              {isRevoked
                ? 'This agent no longer has access through Haven.'
                : isPaused
                  ? 'Paused agents cannot start new payments through Haven.'
                  : 'Pause new requests or revoke the agent budget if you need to stop access.'}
            </p>
            <div className="mt-4 grid gap-2">
              {isActive ? (
                <Button
                  onClick={() => void handlePause()}
                  disabled={pendingAction !== null}
                  variant="ghost"
                  className="w-full"
                >
                  {pendingAction === 'pause' ? 'Pausing...' : 'Pause requests'}
                </Button>
              ) : null}
              {isPaused ? (
                <Button
                  onClick={() => void handleResume()}
                  disabled={pendingAction !== null}
                  className="w-full"
                >
                  {pendingAction === 'resume' ? 'Resuming...' : 'Resume requests'}
                </Button>
              ) : null}
              {!isRevoked ? (
                <Button
                  onClick={() => setConfirmAction('revoke')}
                  disabled={pendingAction !== null || revokeBlockedByOtherDevice}
                  variant="danger"
                  className="w-full"
                >
                  Revoke agent budget
                </Button>
              ) : (
                <Button
                  onClick={() => setConfirmAction('delete')}
                  disabled={pendingAction !== null}
                  variant="danger"
                  className="w-full"
                >
                  Delete agent
                </Button>
              )}
            </div>
          </Card>

          {!isRevoked ? (
            <Card hover={false} className="p-5">
              <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Haven credential</h2>
              <p className="mt-2 text-sm leading-relaxed text-[var(--v2-ink-2)]">
                Your agent uses this credential to request payments through Haven.
              </p>
              <div className="mt-4 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-3">
                <code className="block truncate font-mono text-xs text-[var(--v2-ink-2)]">
                  {fullCredential && showCredential ? fullCredential : maskedCredential}
                </code>
                {fullCredential ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setShowCredential((value) => !value)}
                    >
                      {showCredential ? 'Hide' : 'Show'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void copyCredential()}>
                      {credentialCopied ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                ) : (
                  <p className="mt-3 text-xs leading-relaxed text-[var(--v2-ink-3)]">
                    Haven only shows the full credential when you create the agent. If you lose it, create a new agent or rotate the credential.
                  </p>
                )}
              </div>
            </Card>
          ) : null}

          <Card hover={false} className="p-5">
            <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Advanced details</h2>
            <p className="mt-2 text-sm leading-relaxed text-[var(--v2-ink-2)]">
              Technical identifiers are shown here for recovery and debugging.
            </p>
            {currentAgent.delegate_address ? (
              <div className="mt-4">
                <p className="text-xs font-medium text-[var(--v2-ink-3)]">Credential address</p>
                <div className="mt-2 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-3">
                  <code className="block break-all font-mono text-xs text-[var(--v2-ink)]">
                    {currentAgent.delegate_address}
                  </code>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void copyDelegateAddress()}
                    className="mt-3"
                  >
                    {delegateCopied ? 'Copied' : 'Copy address'}
                  </Button>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                  If this credential address is ever compromised, revoke this agent and create a new one.
                </p>
              </div>
            ) : (
              <p className="mt-4 text-sm text-[var(--v2-ink-2)]">This agent does not currently expose a credential address.</p>
            )}
          </Card>
        </aside>
      </div>

      <ConfirmDialog
        open={confirmAction === 'revoke'}
        onCancel={() => setConfirmAction(null)}
        onConfirm={handleRevoke}
        title="Revoke this agent?"
        body="This removes the agent budget from the Haven wallet. The agent will need a new setup if you want to use it again."
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
