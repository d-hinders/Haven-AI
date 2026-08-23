'use client'

import { ArrowRight, EllipsisVertical } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { usePublicClient } from 'wagmi'
import { type Address } from 'viem'
import { useAuth } from '@/context/AuthContext'
import { useAgents } from '@/hooks/useAgents'
import {
  useAgentActivity,
  isPaymentActivityItem,
  isMcpToolCallActivityItem,
  type PaymentActivityItem,
  type McpToolCallActivityItem,
} from '@/hooks/useAgentActivity'
import { useOnChainAllowances } from '@/hooks/useOnChainAllowances'
import { useDelegateBalance } from '@/hooks/useDelegateBalance'
import { useSafeOperationGate } from '@/hooks/useSafeOperationGate'
import { useSafeDetails } from '@/hooks/useSafeDetails'
import { RESET_PERIODS } from '@/lib/allowance-module'
import { formatAllowanceAmount } from '@/lib/allowance-format'
import { getChainConfig, DEFAULT_CHAIN_ID } from '@/lib/chains'
import { isMachinePaymentSource, parseX402Hostname, paymentSourceTitle } from '@/lib/transaction-labels'
import { truncate, timeAgo } from '@/lib/format'
import { formatAgentLastActivityTitle, formatAgentLastActivityValue } from '@/lib/agent-last-seen'
import {
  activityStatusPresentation,
  agentStatusPresentation,
  failedOrRejectedStatus,
} from '@/lib/payment-status'
import { isUserRejectedError, revokeAgentOnChain } from '@/lib/revoke-agent'
import { isSafeCapableSigner, useActiveSigner } from '@/lib/signer'
import EditAgentModal, { type EditAgentModalMode } from '@/components/EditAgentModal'
import DelegationBudgetCard, { DELEGATION_BUDGET_CARD_ID } from '@/components/DelegationBudgetCard'
import AgentPassportCard from '@/components/AgentPassportCard'
import PaymentCredentialsModal from '@/components/PaymentCredentialsModal'
import ConfirmDialog from '@/components/ConfirmDialog'
import { RemoveAgentDialog } from '@/components/agent-panel/RemoveAgentDialog'
import { ReplaceSigningKeyModal } from '@/components/agent-panel/ReplaceSigningKeyModal'
import { useAgentPassport } from '@/hooks/useAgentPassport'
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
import { Row } from '@/components/ui/Row'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Skeleton } from '@/components/ui/Skeleton'
import { Tooltip } from '@/components/ui/Tooltip'
import TransactionsTable from '@/components/transactions/TransactionsTable'
import {
  AgentRulesSummary,
  ApprovalRequiredBanner,
  TransactionMovement,
} from '@/components/haven'
import type { AggregatedTransaction } from '@/types/transactions'

function activityTitle(item: PaymentActivityItem, agentName?: string): string {
  const sourceTitle = paymentSourceTitle(item.source)
  if (sourceTitle) {
    return agentName ? `${sourceTitle} by ${agentName}` : sourceTitle
  }
  if (item.type === 'approval') return 'Approval request'
  if (item.status === 'failed') return 'Payment failed'
  if (item.status === 'rejected') return 'Payment rejected'
  return 'Agent payment'
}

function activityMovement(item: PaymentActivityItem, walletName: string) {
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

function activityWalletName(item: PaymentActivityItem, fallbackName: string): string {
  if (item.safe_name) return item.safe_name
  if (item.safe_address) return `Haven wallet ${truncate(item.safe_address)}`
  return fallbackName
}

// Adapts the agent activity feed (payments + approvals) into the shape the
// shared TransactionsTable expects, so the agent detail screen reuses the
// same primitive — and the same tinted header band — as the other
// transaction surfaces. Approval items without a tx hash render with no
// external link via `explorerUrl: null`.
function activityToTransaction(
  item: PaymentActivityItem,
  agentName: string,
  walletName: string,
): AggregatedTransaction {
  const status = activityStatusPresentation(item.status)
  const isError = failedOrRejectedStatus(item.status)
  const createdMs = new Date(item.created_at).getTime()
  const rowWalletName = activityWalletName(item, walletName)
  return {
    hash: item.tx_hash ?? `activity-${item.type}-${item.id}`,
    type: 'erc20',
    from: item.safe_address ?? '',
    to: item.to,
    value: item.amount_raw ?? '0',
    valueFormatted: item.amount,
    asset: item.token,
    decimals: 0,
    direction: 'out',
    timestamp: Number.isFinite(createdMs) ? Math.floor(createdMs / 1000) : 0,
    blockNumber: 0,
    isError,
    tokenAddress: item.token_address ?? undefined,
    agentName,
    source: item.source as AggregatedTransaction['source'],
    x402ResourceUrl: item.x402_resource_url ?? null,
    x402MerchantAddress: item.x402_merchant_address ?? null,
    chainId: item.chain_id ?? 0,
    safeId: item.safe_id ?? '',
    safeAddress: item.safe_address ?? '',
    safeName: rowWalletName,
    agentId: item.agent_id,
    paymentId: item.id,
    paymentProofStatus: item.payment_proof_status ?? null,
    paymentFlowStatus: item.payment_flow_status ?? null,
    paymentAttentionReason: item.payment_attention_reason ?? null,
    statusBadge: { label: status.label, tone: status.tone },
    titleOverride: activityTitle(item, agentName),
    movementOverride: activityMovement(item, rowWalletName),
    explorerUrl: item.explorer_url,
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

function mcpToolCallTone(resultStatus: string): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (resultStatus) {
    case 'ok':
      return 'success'
    case 'denied':
      return 'danger'
    case 'error':
      return 'warning'
    default:
      return 'neutral'
  }
}

/**
 * Surfaces the agent_tool_invocations audit log produced when an MCP server
 * tags Haven API calls with X-Haven-MCP-Tool. Money-moving calls are still
 * shown in the transactions table above; this panel exists so read-only
 * tool calls (status checks, allowance reads) are also visible — that's
 * the user-facing piece of the issue #163 audit-log requirement.
 */
function McpToolCallsPanel({
  items,
  loading,
}: {
  items: McpToolCallActivityItem[]
  loading: boolean
}) {
  if (loading && items.length === 0) return null
  if (!loading && items.length === 0) return null

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-base font-semibold text-[var(--v2-ink)]">MCP tool calls</h2>
        <p className="mt-1 text-sm text-[var(--v2-ink-3)]">
          Tool invocations from an MCP-connected agent runtime. The on-chain
          allowance is the real spend gate; this list is an audit trail.
        </p>
      </div>
      <Card hover={false}>
        <ul className="divide-y divide-[var(--v2-divider)]">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <code className="truncate text-sm font-medium text-[var(--v2-ink)]">{item.tool_name}</code>
                  <StatusBadge tone={mcpToolCallTone(item.result_status)}>{item.result_status}</StatusBadge>
                </div>
                <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
                  {item.next_action ? `next: ${item.next_action}` : ''}
                  {item.next_action && item.error_code ? ' · ' : ''}
                  {item.error_code ? `error: ${item.error_code}` : ''}
                  {!item.next_action && !item.error_code && item.payment_id
                    ? `payment ${item.payment_id.slice(0, 8)}…`
                    : ''}
                </p>
              </div>
              <span className="shrink-0 text-xs text-[var(--v2-ink-3)]">{timeAgo(item.created_at)}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
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

type PendingAction = 'pause' | 'resume' | 'revoke' | 'restore' | null
type ConfirmAction = 'revoke' | null

export default function AgentDetailClient({ agentId }: Props) {
  const { user } = useAuth()
  const router = useRouter()
  const { agents, loading, pauseAgent, resumeAgent, revokeAgent, archiveAgent, unarchiveAgent, refetch } =
    useAgents()
  const agent = agents.find((item) => item.id === agentId) ?? null
  const safe = useMemo(
    () => user?.safes.find((item) => item.id === agent?.safe_id) ?? null,
    [agent?.safe_id, user?.safes],
  )
  const safeAddress = safe?.safe_address ?? agent?.safe_address ?? null
  const chainId = safe?.chain_id ?? agent?.safe_chain_id ?? DEFAULT_CHAIN_ID
  const chainConfig = useMemo(() => {
    try {
      return getChainConfig(chainId)
    } catch {
      return null
    }
  }, [chainId])
  const { details: safeDetails } = useSafeDetails(safeAddress, { chainId })
  const { activity, stats, loading: activityLoading } = useAgentActivity(agent?.id ?? null)
  const unsettledPayments = useMemo(
    () => activity
      .filter(isPaymentActivityItem)
      .filter((item) => item.payment_attention_reason === 'merchant_retry_rejected_after_payment'),
    [activity],
  )
  // Gate recovery UI on the delegate EOA actually holding *recoverable* funds — not
  // on a funded-but-unsettled payment record (which can linger after a sweep), and
  // specifically on USDC, since the gasless recovery path is USDC-only. #1403:
  // the read is status-agnostic now — revoked agents resolve too, and that is
  // the POINT: the sequence that strands delegate funds (agent misbehaving
  // mid-x402 → revoke) is the one that needs the recovery banner. The hook's
  // catch treats errors as "nothing to recover", so a failing read degrades
  // silently rather than blocking.
  const { balance: delegateBalance, hasRecoverableUsdc } = useDelegateBalance(
    agent ? agentId : null,
  )
  // #1098: the human field can be absent while atomic is set (a partial API
  // response mid-load) — "Recover undefined USDC" is worse than the generic
  // copy, so the summary requires BOTH fields.
  const strandedSummary =
    delegateBalance && delegateBalance.usdc_atomic !== '0' && delegateBalance.usdc
      ? `${delegateBalance.usdc} USDC`
      : null
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
  const activeSigner = useActiveSigner({
    safeAddress: safeAddress ? (safeAddress as Address) : undefined,
    chainId,
  })
  // Revoking here is a Safe transaction — only a Safe-capable signer applies.
  // Delegation agents hide this path entirely (#1079).
  const signer = isSafeCapableSigner(activeSigner) ? activeSigner : null
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
  const [rotatedKeyPatch, setRotatedKeyPatch] = useState<{ api_key: string; api_key_prefix: string } | null>(null)
  const openEditAgent = () => {
    setEditMode('agent')
    setEditOpen(true)
  }
  const isDelegationAgent = agent?.account_type === 'delegator_hybrid'
  const openUpdateBudget = () => {
    if (isDelegationAgent) {
      // Routing fix (#1079): on the delegation rail the budget control is
      // DelegationBudgetCard on this same page — EditAgentModal is the legacy
      // AllowanceModule editor and can never succeed here. Scroll, don't open.
      document
        .getElementById(DELEGATION_BUDGET_CARD_ID)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    setEditMode('budget')
    setEditOpen(true)
  }
  const closeEdit = () => {
    setEditOpen(false)
  }
  const [pendingAction, setPendingAction] = useState<PendingAction>(null)
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [replaceKeyOpen, setReplaceKeyOpen] = useState(false)

  // #1701: drives the passport disclosure in the re-key flow. Only an agent
  // that HAS a passport has one to leave pointing at the retired key (#1847),
  // so the warning is shown on evidence rather than unconditionally.
  const { passport } = useAgentPassport(agentId)

  const isActive = agent?.status === 'active'
  const isPaused = agent?.status === 'paused'
  const isRevoked = agent?.status === 'revoked'
  const isArchived = Boolean(agent?.archived_at)

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

  const currentAgent = rotatedKeyPatch ? { ...agent, ...rotatedKeyPatch } : agent
  const walletName = currentAgent.safe_name ?? safe?.name ?? 'Unassigned Haven wallet'
  const networkName = chainConfig?.name ?? 'Unknown network'
  const budgetLines = currentAgent.allowances.map((allowance) => {
    const decimals =
      chainConfig &&
      Object.values(chainConfig.tokens).find((token) => token.symbol === allowance.token_symbol)?.decimals
    const amount = formatAllowanceAmount(allowance.allowance_amount, decimals ?? 18, {
      symbol: allowance.token_symbol,
    })
    return {
      id: allowance.id,
      label: `${amount} ${allowance.token_symbol} ${budgetPeriodLabel(allowance.reset_period_min)}`,
      token: allowance.token_symbol,
      amount,
      period: budgetPeriodLabel(allowance.reset_period_min),
    }
  })
  // #796/#804: recipients bind per token — the card gets EVERY configured
  // token (a picker appears only when there is more than one).
  const recipientTokens = currentAgent.allowances.flatMap((allowance) => {
    if (!chainConfig) return []
    const cfg = Object.values(chainConfig.tokens).find((t) => t.symbol === allowance.token_symbol)
    if (!cfg) return []
    return [{
      address: (cfg.address ?? allowance.token_address) as string,
      symbol: cfg.symbol,
      decimals: cfg.decimals,
    }]
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

  // #1402: restores list placement only — the agent stays revoked. Runs
  // under pendingAction so a double-click can't fire unarchive twice and
  // paint a false failure over a restore that already succeeded.
  async function handleRestore() {
    setPendingAction('restore')
    setErrorMessage(null)
    try {
      await unarchiveAgent(currentAgent.id)
    } catch {
      setErrorMessage('The agent could not be restored to the list')
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
    <div className="max-w-5xl">
      <PageHeader
        title={currentAgent.name}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {currentAgent.status === 'active' ? null : (
              <StatusBadge tone={agentStatus.tone}>
                {agentStatus.label}
              </StatusBadge>
            )}
            {!isRevoked ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label="Agent options"
                  disabled={pendingAction !== null}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-[var(--v2-border)] bg-white text-[var(--v2-ink-2)] transition-colors hover:border-[var(--v2-border-strong)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Icon icon={EllipsisVertical} className="h-4 w-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onSelect={openEditAgent}>Edit agent</DropdownMenuItem>
                  <DropdownMenuItem onSelect={openUpdateBudget}>Update budget</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setCredentialsOpen(true)}>
                    Payment credentials
                  </DropdownMenuItem>
                  {/* #1701. Delegation rail only — re-key replaces a signed
                      delegation, which an older account simply does not have.
                      The entry stays reachable on BOTH rails and the modal
                      carries the refusal, rather than being disabled here: an
                      owner whose key is lost needs to learn that re-onboarding
                      is the path, and neither a hidden item nor a greyed one
                      can tell them. A disabled button would also put the
                      reason in a hover tooltip, which a keyboard or touch user
                      never sees. */}
                  <DropdownMenuItem onSelect={() => setReplaceKeyOpen(true)}>
                    Replace signing key
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
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
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
          <div>
            <dt className="text-xs font-medium text-[var(--v2-ink-3)]">Last activity</dt>
            <dd
              className="mt-1 font-medium text-[var(--v2-ink)] v2-tabular"
              title={formatAgentLastActivityTitle(currentAgent.mcp_last_seen_at)}
            >
              {formatAgentLastActivityValue(currentAgent.mcp_last_seen_at)}
            </dd>
          </div>
        </dl>
      </Card>

      {revokeBlockedByOtherDevice ? (
        <PasskeyOtherDeviceNotice className="mt-4" />
      ) : null}

      {currentAgent.account_type === 'delegator_hybrid' ? (
        <>
          <div id={DELEGATION_BUDGET_CARD_ID} className="scroll-mt-24">
            <DelegationBudgetCard
              agentId={agentId}
              chainId={chainId}
              tokens={recipientTokens}
              onBudgetChange={refetch}
            />
          </div>
          {/* #1089: backup & recovery moved to the account page — it's an
              account capability, not an agent one. This is a pointer, not a
              second copy of the controls. */}
          {safe ? (
            <Card hover={false} className="mt-6 p-2">
              <Row
                href={`/accounts/${safe.id}`}
                title="Backup & recovery"
                subtitle="Manage the ways this account can be approved"
                trailing={<Icon icon={ArrowRight} className="h-4 w-4 text-[var(--v2-ink-3)]" />}
              />
            </Card>
          ) : null}
        </>
      ) : null}
      {/* Session-rail banner + recipients card retired with the rail (#834);
          legacy AllowanceModule accounts manage budgets via EditAgentModal. */}

      {isPaused ? (
        <div className="mt-4">
          <ApprovalRequiredBanner title="Paused in Haven" tone="neutral" density="compact">
            New agent payments are blocked until you resume this agent. Existing wallet rules stay in place.
          </ApprovalRequiredBanner>
        </div>
      ) : null}

      {hasRecoverableUsdc ? (
        <div className="mt-4">
          <ApprovalRequiredBanner title="Recoverable funds in agent wallet" tone="warning" density="compact">
            <span>
              {unsettledPayments.length > 0
                ? 'A payment was funded on-chain but didn’t reach the merchant, leaving money in your agent’s wallet.'
                : 'Your agent’s wallet is holding funds that weren’t spent.'}{' '}
              {strandedSummary
                ? `Recover ${strandedSummary} to your Haven wallet.`
                : 'Recover it to your Haven wallet.'}
            </span>
            <div className="mt-2">
              <a
                href={`/agents/${agentId}/sweep`}
                className="inline-flex items-center gap-1 rounded-md bg-[var(--v2-warning)] px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 transition-opacity"
                aria-label="Recover funds to your Haven wallet"
              >
                Recover funds
                <Icon icon={ArrowRight} className="h-3 w-3" />
              </a>
            </div>
          </ApprovalRequiredBanner>
        </div>
      ) : null}

      {errorMessage ? (
        <div className="mt-4 rounded-xl border border-danger/20 bg-[var(--v2-danger-soft)] px-4 py-3">
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

      <AgentPassportCard agentId={agentId} agentRevoked={isRevoked} />

      <div className="mt-6 space-y-6">
          <AgentRulesSummary
            title="Agent budget"
            description="What this agent can spend, where the money comes from, and how you stay in control."
            items={[
              {
                label: 'Agent name',
                value: currentAgent.name,
                helper: currentAgent.description || undefined,
              },
              {
                label: 'Spend from',
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
                  {/* Safe revoke is an AllowanceModule teardown; on delegation
                      agents the whole shutdown is Remove below (#1402), so the
                      Safe control is hidden there. */}
                  {!isRevoked && !isDelegationAgent ? (
                    <Button
                      onClick={() => setConfirmAction('revoke')}
                      disabled={pendingAction !== null || revokeBlockedByOtherDevice}
                      variant="danger"
                      size="sm"
                    >
                      Revoke agent budget
                    </Button>
                  ) : null}
                  {/* #1402: Remove — delegation agents any time while not yet
                      archived; legacy agents once revoked (archive-only leg). */}
                  {!isArchived && (isDelegationAgent || isRevoked) ? (
                    <Button
                      onClick={() => setRemoveOpen(true)}
                      disabled={pendingAction !== null}
                      variant="danger"
                      size="sm"
                    >
                      Remove agent
                    </Button>
                  ) : null}
                  {isArchived ? (
                    <Button
                      onClick={() => void handleRestore()}
                      disabled={pendingAction !== null}
                      variant="ghost"
                      size="sm"
                    >
                      {pendingAction === 'restore' ? 'Restoring…' : 'Restore to list'}
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

          <div>
            <div className="mb-4">
              <h2 className="text-base font-semibold text-[var(--v2-ink)]">Recent activity</h2>
              <p className="mt-1 text-sm text-[var(--v2-ink-3)]">Payments and approval requests from this agent.</p>
            </div>
            <Card hover={false}>
              <TransactionsTable
                transactions={activity.filter(isPaymentActivityItem).map((item) =>
                  activityToTransaction(item, currentAgent.name, walletName),
                )}
                loading={activityLoading}
                error={null}
                onRefresh={() => {}}
                hasActiveFilters={false}
                variant="card"
                density="compact"
                columns={['direction', 'activity', 'fromTo', 'date', 'amount', 'link']}
                emptyState={{
                  title: 'No activity yet',
                  body: 'Payments, approvals, and confirmations for this agent will appear here.',
                }}
              />
            </Card>
          </div>

          <McpToolCallsPanel
            items={activity.filter(isMcpToolCallActivityItem)}
            loading={activityLoading}
          />

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

      {removeOpen && currentAgent ? (
        <RemoveAgentDialog
          agent={currentAgent}
          chainId={chainId}
          onRevokeCredential={() => revokeAgent(currentAgent.id)}
          onArchive={async () => {
            await archiveAgent(currentAgent.id)
            // The agent now lives under Removed on the list — land the user
            // there rather than on a page whose actions just disappeared.
            router.push('/agents')
          }}
          onClose={() => setRemoveOpen(false)}
        />
      ) : null}

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

      <ReplaceSigningKeyModal
        open={replaceKeyOpen}
        onClose={() => setReplaceKeyOpen(false)}
        agentId={agentId}
        agentName={currentAgent.name}
        chainId={chainId}
        isDelegationAgent={isDelegationAgent}
        currentDelegateAddress={currentAgent.delegate_address}
        recentPayments={activity.filter(isPaymentActivityItem)}
        hasPassport={passport !== null}
        onCompleted={() => {
          refetch()
        }}
      />

      <PaymentCredentialsModal
        open={credentialsOpen}
        onClose={() => {
          setCredentialsOpen(false)
          setRotatedKeyPatch(null)
        }}
        agent={currentAgent}
        onKeyRotated={(newKey, newPrefix) => {
          setRotatedKeyPatch({ api_key: newKey, api_key_prefix: newPrefix })
        }}
      />
    </div>
  )
}
