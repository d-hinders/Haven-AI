'use client'

import { ArrowRight, EllipsisVertical } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/context/AuthContext'
import { useAgents } from '@/hooks/useAgents'
import {
  useAgentActivity,
  isPaymentActivityItem,
  isMcpToolCallActivityItem,
  type PaymentActivityItem,
  type McpToolCallActivityItem,
} from '@/hooks/useAgentActivity'
import { useDelegateBalance } from '@/hooks/useDelegateBalance'
import { RESET_PERIODS } from '@/lib/budget-period'
import { formatAllowanceAmount } from '@/lib/allowance-format'
import { getChainConfig, DEFAULT_CHAIN_ID } from '@/lib/chains'
import { isMachinePaymentSource, parseX402Hostname, paymentSourceTitle } from '@/lib/transaction-labels'
import { truncate, timeAgo } from '@/lib/format'
import { formatAgentLastActivityTitle, formatAgentLastActivityValue } from '@/lib/agent-last-seen'
import { AGENT_PAUSED_BODY, AGENT_PAUSED_TITLE } from '@/lib/agent-pause-copy'
import {
  STRANDED_FUNDS_TITLE,
  reviewStrandedPaymentsLabel,
  strandedFundsCauseWithLocation,
} from '@/lib/stranded-funds-copy'
import {
  agentStatusPresentation,
  paymentStatusPresentation,
  failedOrRejectedStatus,
} from '@/lib/payment-status'
import EditAgentModal from '@/components/EditAgentModal'
import DelegationBudgetCard, { DELEGATION_BUDGET_CARD_ID } from '@/components/DelegationBudgetCard'
import AgentPassportCard from '@/components/AgentPassportCard'
import PaymentCredentialsModal from '@/components/PaymentCredentialsModal'
import { RemoveAgentDialog } from '@/components/agent-panel/RemoveAgentDialog'
import { ReplaceSigningKeyModal } from '@/components/agent-panel/ReplaceSigningKeyModal'
import { useAgentPassport } from '@/hooks/useAgentPassport'
import { useRetiredRailOwnerAccess } from '@/hooks/useRetiredRailOwnerAccess'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'
import RetiredRailNotice from '@/components/RetiredRailNotice'
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
  // #2120: the `'approval'` row title and the `'rejected'` status title went
  // with the queue — no backend route can emit either (see the decision note
  // in `lib/payment-status.ts`), and the narrowed types now say so.
  if (item.status === 'failed') return 'Payment failed'
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
  // #2120: was `activityStatusPresentation`, which merged an approval-status
  // family into this lookup. Activity rows carry `payment_intents.status` and
  // nothing else since #2055, so the merge had no second family left to merge.
  const status = paymentStatusPresentation(item.status)
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
          Tool invocations from an MCP-connected agent runtime. This list is an
          audit trail, not a spending control.
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

/**
 * Anchor for the "Recent activity" section (#2196), mirroring
 * `DELEGATION_BUDGET_CARD_ID`'s scroll-don't-open pattern in this same file.
 *
 * **What this link claims, and what it deliberately does not.** The
 * recoverable-funds banner sits near the top of the page; the rows that carry
 * the `Needs attention` badge are ~1200px below it at 1280, past two stat
 * cards, the passport card and the whole budget card. Nothing connected them.
 *
 * The connection drawn here is NAVIGATIONAL — "the payments this warning is
 * about are down there, and there are N of them". It is NOT attributive, and
 * that is a fact about the data rather than a matter of taste:
 *
 * - The banner's figure is the delegate EOA's **live USDC balance**
 *   (`GET /agents/:id/delegate-balance` → `routes/agents.ts`, an on-chain
 *   `getTokenBalance` read). No field anywhere apportions that balance to a
 *   payment intent, and none of `payment_intents`,
 *   `machine_payment_reconciliation_events` or the activity projection carries
 *   a per-intent stranded amount.
 * - `unsettledPayments` can hold more than one row (the reconciliation upsert
 *   is unique per `(payment_intent_id, event_type)`, not per agent), so there
 *   is not always a "the" payment to point at.
 * - A partially swept balance, or a balance left over from an earlier
 *   incident, would make a per-payment claim simply false.
 *
 * So the banner does not say "this 8.00 USDC came from that payment", and the
 * activity row does not grow a Recover button implying its own funds are the
 * recoverable ones. Both would be inventing a link the data cannot support.
 */
const AGENT_ACTIVITY_SECTION_ID = 'agent-activity'

type PendingAction = 'pause' | 'resume' | 'restore' | null

export default function AgentDetailClient({ agentId }: Props) {
  const { user } = useAuth()
  const router = useRouter()
  const {
    agents,
    loading,
    error: agentsError,
    pauseAgent,
    resumeAgent,
    revokeAgent,
    archiveAgent,
    unarchiveAgent,
    refetch,
  } = useAgents()
  const agent = agents.find((item) => item.id === agentId) ?? null
  const safe = useMemo(
    () => user?.safes.find((item) => item.id === agent?.safe_id) ?? null,
    [agent?.safe_id, user?.safes],
  )
  const chainId = safe?.chain_id ?? agent?.safe_chain_id ?? DEFAULT_CHAIN_ID
  const chainConfig = useMemo(() => {
    try {
      return getChainConfig(chainId)
    } catch {
      return null
    }
  }, [chainId])
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
    agent?.account_type === 'delegator_hybrid' ? agentId : null,
  )
  // #1098: the human field can be absent while atomic is set (a partial API
  // response mid-load) — "Recover undefined USDC" is worse than the generic
  // copy, so the summary requires BOTH fields.
  const strandedSummary =
    delegateBalance && delegateBalance.usdc_atomic !== '0' && delegateBalance.usdc
      ? `${delegateBalance.usdc} USDC`
      : null
  const [editOpen, setEditOpen] = useState(false)
  const [credentialsOpen, setCredentialsOpen] = useState(false)
  const [rotatedKeyPatch, setRotatedKeyPatch] = useState<{ api_key: string; api_key_prefix: string } | null>(null)
  const openEditAgent = () => {
    setEditOpen(true)
  }
  const isDelegationAgent = agent?.account_type === 'delegator_hybrid'
  const openUpdateBudget = () => {
    document
      .getElementById(DELEGATION_BUDGET_CARD_ID)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const closeEdit = () => {
    setEditOpen(false)
  }
  // #2196: same mechanism as openUpdateBudget's delegation branch above.
  const scrollToActivity = () => {
    document
      .getElementById(AGENT_ACTIVITY_SECTION_ID)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const [pendingAction, setPendingAction] = useState<PendingAction>(null)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [replaceKeyOpen, setReplaceKeyOpen] = useState(false)

  const retiredRail = useRetiredRailOwnerAccess(
    agent
      ? {
          safe_address: safe?.safe_address ?? agent.safe_address ?? '',
          chain_id: chainId,
          account_type: agent.account_type,
        }
      : null,
  )

  // #1701/#1699: only an anchored attestation is retired and reissued. Pending
  // or failed issuance will read the new delegate if it anchors after re-key.
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
        <div className="rounded-[10px] border border-[var(--v2-border)] bg-white p-8 text-center shadow-card">
          <h1 className="text-xl font-semibold text-[var(--v2-ink)]">
            {agentsError ? 'Agent could not load' : 'Agent not found'}
          </h1>
          <p className="mt-2 text-sm text-[var(--v2-ink-2)]">
            {agentsError
              ? 'Haven could not load this agent right now. Try again before assuming it was removed.'
              : 'This agent may have been removed or you may no longer have access to it.'}
          </p>
          {agentsError ? (
            <Button className="mt-5" size="sm" onClick={() => void refetch()}>
              Try again
            </Button>
          ) : null}
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
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-[var(--v2-border)] bg-white text-[var(--v2-ink-2)] transition-colors hover:border-[var(--v2-border-strong)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Icon icon={EllipsisVertical} className="h-4 w-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onSelect={openEditAgent}>
                    {isDelegationAgent ? 'Edit agent' : 'Rename agent'}
                  </DropdownMenuItem>
                  {isDelegationAgent ? (
                    <>
                      <DropdownMenuItem onSelect={openUpdateBudget}>Update budget</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => setCredentialsOpen(true)}>
                        Payment credentials
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setReplaceKeyOpen(true)}>
                        Replace signing key
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        }
      />

      <Card hover={false} className="p-5 md:p-6">
        <p className="max-w-2xl text-sm leading-relaxed text-[var(--v2-ink-2)]">
          {currentAgent.description || (isDelegationAgent
            ? 'This agent can make payments within the rules you set.'
            : 'This is a historical agent record from a retired Safe account.')}
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
      {currentAgent.account_type !== 'delegator_hybrid' ? (
        <div className="mt-6">
          <RetiredRailNotice ownerAccess={retiredRail.ownerAccess} />
          {!isArchived ? (
            <div className="mt-3 flex justify-end">
              <Button variant="danger" size="sm" onClick={() => setRemoveOpen(true)}>
                Unlink agent
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {agentsError ? (
        <div
          role="alert"
          className="rounded-lg border border-warning/30 bg-[var(--v2-warning-soft)] px-4 py-3 text-sm text-[var(--v2-ink-2)]"
        >
          Agent data could not refresh. This page is showing the last loaded record.
          <Button className="ml-2" size="sm" variant="ghost" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      ) : null}

      {isPaused && isDelegationAgent ? (
        <div className="mt-4">
          {/* #2230: title and body come from `lib/agent-pause-copy.ts`, shared
              with `AgentCard`'s banner one click away. This page's wording is
              the one that was TAKEN — the card said "network permissions" for
              the same fact; see that module for why this one is the settled
              phrasing. The rendered sentence here is byte-identical to what
              stood before. */}
          <ApprovalRequiredBanner title={AGENT_PAUSED_TITLE} tone="neutral" density="compact">
            {AGENT_PAUSED_BODY}
          </ApprovalRequiredBanner>
        </div>
      ) : null}

      {hasRecoverableUsdc ? (
        <div className="mt-4">
          <ApprovalRequiredBanner title={STRANDED_FUNDS_TITLE} tone="warning" density="compact">
            <span>
              {/* #2195: the cause clause is shared with `AgentCard` and count-aware
                  here because this surface holds the LIST, not an EXISTS. */}
              {unsettledPayments.length > 0
                ? strandedFundsCauseWithLocation(unsettledPayments.length)
                : 'Your agent’s wallet is holding funds that weren’t spent.'}{' '}
              {strandedSummary
                ? `Recover ${strandedSummary} to your Haven wallet.`
                : 'Recover it to your Haven wallet.'}
            </span>
            {/* #2203: was a hand-rolled `<a className="px-2.5 py-1 text-xs">` —
                a ~24 CSS px control on the money-recovery path, and the ONLY CTA
                inside an `ApprovalRequiredBanner` in the product app that was not
                already a `Button` (the others: `ReceiveFundsModal.tsx` "Refresh
                page"). Routed through the primitive so it inherits #1726's 44px
                tap-target overlay rather than restating the rule. Brand fill
                rather than the old solid `--v2-warning`, matching the recovery
                affordance in the same-tone banner in `RemoveAgentDialog.tsx`:
                the banner carries the severity, the button carries the action. */}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                href={`/agents/${agentId}/sweep`}
                size="sm"
                trailingIcon
                aria-label="Recover funds to your Haven wallet"
              >
                Recover funds
              </Button>
              {/* #2196: the connection between this warning and the rows that
                  caused it — NAVIGATIONAL only, deliberately. See the comment on
                  AGENT_ACTIVITY_SECTION_ID.

                  `ghost`, not `tertiary`: `tertiary` is transparent with no
                  resting chrome, so against the banner's `--v2-warning-soft`
                  fill it read as prose rather than as a control
                  (`haven-design-reviewer` on this change, off the 1280 and 390
                  captures). `ghost` is also the variant the ONE other `Button`
                  inside an `ApprovalRequiredBanner` uses — `ReceiveFundsModal`'s
                  "Refresh page". It stays a `Button` rather than becoming an
                  inline link so it keeps #1726's 44px hit area: a second
                  control in this banner at 24px would be the defect #2203 was
                  filed about, one row down. */}
              {unsettledPayments.length > 0 ? (
                <Button variant="ghost" size="sm" onClick={scrollToActivity}>
                  {reviewStrandedPaymentsLabel(unsettledPayments.length)}
                </Button>
              ) : null}
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

      {/* #2106: the third tile was "Pending approvals", fed by a backend
          constant of 0 (`routes/agent-activity.ts` — "pending approvals are
          structurally zero — the queue died with the AllowanceModule rail").
          Rendered as a counter it told the user a queue exists and happens to
          be empty; on the delegation rail no queue exists at all — an
          out-of-budget payment REVERTS on-chain, it is never held for
          approval. A tile that can only ever read 0 is removed rather than
          re-labelled. The wire field survives per the #2055 compatibility
          convention; nothing in the UI reads it. */}
      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
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
      </div>

      <AgentPassportCard
        agentId={agentId}
        agentRevoked={isRevoked}
        canIssue={isDelegationAgent}
      />

      <div className="mt-6 space-y-6">
        {isDelegationAgent ? (
          <>
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
                helper: 'Payments above this budget are declined before any money moves.',
              },
            ]}
            footer={
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-[var(--v2-ink-3)]">
                  {isRevoked
                    ? 'This agent no longer has access through Haven.'
                    : isPaused
                      ? 'Paused agents cannot start new payments through Haven.'
                      : 'Pause the agent or remove its budget if you need to stop access.'}
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
                  {!isArchived && isDelegationAgent ? (
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
          </>
        ) : null}

          <div id={AGENT_ACTIVITY_SECTION_ID} className="scroll-mt-24">
            <div className="mb-4">
              <h2 className="text-base font-semibold text-[var(--v2-ink)]">Recent activity</h2>
              {/* #2120: was "Payments and approval requests from this agent." This list
                  has been payments-only since #2055 removed the approval feed entries,
                  so the subtitle promised a row kind the section can never show. */}
              <p className="mt-1 text-sm text-[var(--v2-ink-3)]">Payments made by this agent.</p>
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
                  body: 'Payments for this agent will appear here.',
                }}
              />
            </Card>
          </div>

          <McpToolCallsPanel
            items={activity.filter(isMcpToolCallActivityItem)}
            loading={activityLoading}
          />

      </div>

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
          agent={currentAgent}
          onUpdated={() => {
            refetch()
            setEditOpen(false)
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
        hasAnchoredPassport={passport?.status === 'anchored' && passport.attestation_uid !== null}
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
