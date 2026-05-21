'use client'

import { useMemo, useState } from 'react'
import { usePublicClient } from 'wagmi'
import { type Address } from 'viem'
import { useAuth } from '@/context/AuthContext'
import { useAgents } from '@/hooks/useAgents'
import { useAgentActivity, type ActivityItem } from '@/hooks/useAgentActivity'
import { useOnChainAllowances } from '@/hooks/useOnChainAllowances'
import { useSafeOperationGate } from '@/hooks/useSafeOperationGate'
import { useSafeDetails } from '@/hooks/useSafeDetails'
import { RESET_PERIODS } from '@/lib/allowance-module'
import { formatAllowanceAmount } from '@/lib/allowance-format'
import { getChainConfig } from '@/lib/chains'
import { isMachinePaymentSource, parseX402Hostname, paymentSourceTitle } from '@/lib/transaction-labels'
import { truncate, timeAgo } from '@/lib/format'
import {
  activityStatusPresentation,
  agentStatusPresentation,
  failedOrRejectedStatus,
} from '@/lib/payment-status'
import { isUserRejectedError, revokeAgentOnChain } from '@/lib/revoke-agent'
import { useActiveSigner } from '@/lib/signer'
import EditAgentModal, { type EditAgentModalMode } from '@/components/EditAgentModal'
import PaymentCredentialsModal from '@/components/PaymentCredentialsModal'
import ConfirmDialog from '@/components/ConfirmDialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'
import OnchainActionGate, { OnchainActionNotice, isOnchainActionBlocked } from '@/components/OnchainActionGate'
import PasskeyOtherDeviceNotice from '@/components/PasskeyOtherDeviceNotice'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { EmptyState } from '@/components/ui/EmptyState'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Skeleton } from '@/components/ui/Skeleton'
import { Tooltip } from '@/components/ui/Tooltip'
import {
  AgentActivityRow,
  AgentRulesSummary,
  ApprovalRequiredBanner,
  ExternalDetailsLink,
  TransactionMovement,
} from '@/components/haven'

function activityTitle(item: ActivityItem, agentName?: string): string {
  const sourceTitle = paymentSourceTitle(item.source)
  if (sourceTitle) {
    return agentName ? `${sourceTitle} by ${agentName}` : sourceTitle
  }
  if (item.type === 'approval') return 'Approval request'
  if (item.status === 'failed') return 'Payment failed'
  if (item.status === 'rejected') return 'Payment rejected'
  return 'Agent payment'
}

function activityMovement(item: ActivityItem, walletName: string) {
  const isX402 = isMachinePaymentSource(item.source)
  const hostname = isX402 ? parseX402Hostname(item.x402_resource_url) : null

  const recipient = hostname ? (
    hostname
  ) : (
    <Tooltip label={item.to} mono>
      <span>{truncate(item.to)}</span>
    </Tooltip>
  )

  return <TransactionMovement from={walletName} to={recipient} />
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

type PendingAction = 'pause' | 'resume' | 'revoke' | null
type ConfirmAction = 'revoke' | null

export default function AgentDetailClient({ agentId }: Props) {
  const { user } = useAuth()
  const { agents, loading, pauseAgent, resumeAgent, revokeAgent, refetch } = useAgents()
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
  const revokeApprovalBlocked = isOnchainActionBlocked(operationGate)
  const revokeNoSignerMessage = 'Connect a wallet to revoke this agent budget.'

  const [editOpen, setEditOpen] = useState(false)
  const [editMode, setEditMode] = useState<EditAgentModalMode>('all')
  const [credentialsOpen, setCredentialsOpen] = useState(false)
  const openEditAgent = () => {
    setEditMode('agent')
    setEditOpen(true)
  }
  const openUpdateBudget = () => {
    setEditMode('budget')
    setEditOpen(true)
  }
  const closeEdit = () => {
    setEditOpen(false)
  }
  const [pendingAction, setPendingAction] = useState<PendingAction>(null)
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const isActive = agent?.status === 'active'
  const isPaused = agent?.status === 'paused'
  const isRevoked = agent?.status === 'revoked'

  if (loading) {
    return (
      <div role="status" aria-busy="true" aria-live="polite" aria-label="Loading agent details" className="max-w-5xl">
        <div className="space-y-4">
          <Skeleton variant="text" className="h-6 w-40" />
          <Skeleton className="h-24 rounded-xl" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-28 rounded-xl" />
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
  const approvalCopy =
    budgetLines.length === 0
      ? 'No automatic spending is configured for this agent.'
      : 'Payments within budget can run automatically. Larger payments need your manual approval.'
  const agentStatus = agentStatusPresentation(currentAgent.status)

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
      <PageHeader
        title={currentAgent.name}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge tone={agentStatus.tone}>
              {agentStatus.label}
            </StatusBadge>
            {!isRevoked ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label="Agent options"
                  disabled={pendingAction !== null}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-[var(--v2-border)] bg-white text-[var(--v2-ink-2)] transition-colors hover:border-[var(--v2-border-strong)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <svg
                    className="h-4 w-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="5" r="1.25" />
                    <circle cx="12" cy="12" r="1.25" />
                    <circle cx="12" cy="19" r="1.25" />
                  </svg>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onSelect={openEditAgent}>Edit agent</DropdownMenuItem>
                  <DropdownMenuItem onSelect={openUpdateBudget}>Update budget</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setCredentialsOpen(true)}>
                    Payment credentials
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        }
      />

      <Card hover={false} className="p-5 md:p-6">
        <p className="max-w-2xl text-sm leading-relaxed text-[var(--v2-ink-2)]">
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

      <div className="mt-6 space-y-6">
          <AgentRulesSummary
            title="Agent budget"
            description="What this agent can spend, where the money comes from, and how you stay in control."
            items={[
              {
                label: 'Who can spend',
                value: currentAgent.name,
                helper: currentAgent.description || undefined,
              },
              {
                label: 'From account',
                value: `${walletName} on ${networkName}`,
                helper: 'Payments come from this Haven account only.',
              },
              {
                label: 'Budget',
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
            footer={
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-[var(--v2-ink-3)]">
                  {isRevoked
                    ? 'This agent no longer has access through Haven.'
                    : isPaused
                      ? 'Paused agents cannot start new payments through Haven.'
                      : 'Pause the agent or revoke its budget if you need to stop access.'}
                </p>
                <div className="flex flex-wrap gap-2">
                  {!isRevoked ? (
                    <Button
                      onClick={openUpdateBudget}
                      disabled={pendingAction !== null}
                      variant="ghost"
                      size="sm"
                    >
                      Update budget
                    </Button>
                  ) : null}
                  {isActive ? (
                    <Button
                      onClick={() => void handlePause()}
                      disabled={pendingAction !== null}
                      variant="ghost"
                      size="sm"
                    >
                      {pendingAction === 'pause' ? 'Pausing…' : 'Pause agent'}
                    </Button>
                  ) : null}
                  {isPaused ? (
                    <Button
                      onClick={() => void handleResume()}
                      disabled={pendingAction !== null}
                      variant="ghost"
                      size="sm"
                    >
                      {pendingAction === 'resume' ? 'Resuming…' : 'Resume agent'}
                    </Button>
                  ) : null}
                  {!isRevoked ? (
                    <Button
                      onClick={() => setConfirmAction('revoke')}
                      disabled={pendingAction !== null || revokeBlockedByOtherDevice}
                      variant="danger"
                      size="sm"
                    >
                      Revoke agent budget
                    </Button>
                  ) : null}
                </div>
              </div>
            }
          />

          {budgetLines.length === 0 ? (
            <EmptyState
              title="No agent budget set"
              body={isRevoked ? 'This agent has been revoked and can no longer be edited.' : 'Add an agent budget before this agent can make automatic payments.'}
              action={!isRevoked ? <Button size="sm" onClick={openUpdateBudget}>Add budget</Button> : undefined}
            />
          ) : null}

          <Card hover={false} className="overflow-hidden">
            <div className="border-b border-[var(--v2-border)] bg-[var(--v2-surface)] px-5 py-4">
              <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Recent activity</h2>
              <p className="mt-1 text-xs text-[var(--v2-ink-2)]">Payments and approval requests from this agent.</p>
            </div>

            {activityLoading ? (
              <div className="p-5 space-y-3">
                {[0, 1, 2].map((index) => (
                  <Skeleton key={index} className="h-14 rounded-lg" />
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
                {activity.map((item) => {
                  const status = activityStatusPresentation(item.status)
                  return (
                    <AgentActivityRow
                      key={`${item.type}-${item.id}`}
                      title={activityTitle(item, currentAgent.name)}
                      description={activityMovement(item, walletName)}
                      amount={`-${item.amount} ${item.token}`}
                      amountTone={failedOrRejectedStatus(item.status) ? 'danger' : 'neutral'}
                      status={status.label}
                      statusTone={status.tone}
                      timestamp={timeAgo(item.created_at)}
                      action={
                        item.tx_hash && item.explorer_url ? (
                          <ExternalDetailsLink href={item.explorer_url} />
                        ) : undefined
                      }
                    />
                  )
                })}
              </div>
            )}
          </Card>

      </div>

      <ConfirmDialog
        open={confirmAction === 'revoke'}
        onCancel={() => setConfirmAction(null)}
        onConfirm={handleRevoke}
        title="Revoke this agent?"
        body={(
          <>
            <p>
              This removes the agent budget from the Haven wallet. The agent will need a new setup if you want to use it again.
            </p>
            <OnchainActionNotice
              operationGate={operationGate}
              noSignerMessage={revokeNoSignerMessage}
              className="mt-4"
            />
          </>
        )}
        confirmLabel="Revoke agent"
        loading={pendingAction === 'revoke'}
        confirmDisabled={revokeApprovalBlocked}
        confirmButtonWrapper={(button) => (
          <OnchainActionGate
            requiredChainId={chainId}
            operationGate={operationGate}
            noSignerMessage={revokeNoSignerMessage}
            showNotice={false}
            className="min-w-44"
          >
            {() => button}
          </OnchainActionGate>
        )}
      />

      {!isRevoked ? (
        <EditAgentModal
          open={editOpen}
          onClose={closeEdit}
          mode={editMode}
          agent={currentAgent}
          safeAddress={safeAddress ?? ''}
          chainId={chainId}
          safeDetails={safeDetails}
          existingOnChainAllowances={existingOnChainAllowances}
          onUpdated={() => {
            refetch()
            setEditOpen(false)
            void refetchOnChain()
          }}
        />
      ) : null}

      <PaymentCredentialsModal
        open={credentialsOpen}
        onClose={() => setCredentialsOpen(false)}
        agent={currentAgent}
      />
    </div>
  )
}
