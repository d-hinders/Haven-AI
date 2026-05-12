'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import type { Address } from 'viem'
import { useAuth } from '@/context/AuthContext'
import { usePreferences } from '@/hooks/usePreferences'
import { useContacts } from '@/hooks/useContacts'
import { useAgents } from '@/hooks/useAgents'
import { useAggregatedBalances } from '@/hooks/useAggregatedPortfolio'
import { useDashboardOverview } from '@/hooks/useDashboardOverview'
import { useBalances } from '@/hooks/useBalances'
import { useSafeDetails } from '@/hooks/useSafeDetails'
import { useSafeOperationGate } from '@/hooks/useSafeOperationGate'
import { RESET_PERIODS } from '@/lib/allowance-module'
import { getChainConfig } from '@/lib/chains'
import { parseX402Hostname } from '@/lib/transaction-labels'
import { truncate, timeAgo } from '@/lib/format'
import DashboardOnboardingGuide from '@/components/DashboardOnboardingGuide'
import CreateAgentModal from '@/components/CreateAgentModal'
import SendModal from '@/components/SendModal'
import DashboardActionPickerModal from '@/components/DashboardActionPickerModal'
import ReceiveFundsModal from '@/components/ReceiveFundsModal'
import ComingSoonModal from '@/components/ComingSoonModal'
import PasskeyOtherDeviceNotice from '@/components/PasskeyOtherDeviceNotice'
import { Button } from '@/components/ui/Button'
import { TransactionActivityRow, TransactionMovement } from '@/components/haven'
import type { DashboardAgentPreview } from '@/types/dashboard'
import type { AggregatedTransaction } from '@/types/transactions'

function formatCurrency(value: number, currency: 'USD' | 'EUR'): string {
  return new Intl.NumberFormat(currency === 'EUR' ? 'de-DE' : 'en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

function formatCompactCurrency(value: number, currency: 'USD' | 'EUR'): string {
  return new Intl.NumberFormat(currency === 'EUR' ? 'de-DE' : 'en-US', {
    style: 'currency',
    currency,
    notation: Math.abs(value) >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: 2,
  }).format(value)
}

function formatSignedCurrency(value: number, currency: 'USD' | 'EUR'): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  return `${sign}${formatCurrency(Math.abs(value), currency)}`
}

function formatPercent(value: number): string {
  return `${value > 0 ? '+' : value < 0 ? '-' : ''}${Math.abs(value).toFixed(2)}%`
}

function statusLabel(status: string): string {
  if (status === 'active') return 'Connected'
  if (status === 'paused') return 'Paused'
  return status
}

function statusClasses(status: string): string {
  if (status === 'active') return 'bg-[var(--v2-success-soft)] text-[var(--v2-success)]'
  if (status === 'paused') return 'bg-[var(--v2-warning-soft)] text-[var(--v2-warning)]'
  return 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-3)]'
}

function formatAllowanceAmount(amount: string, tokenSymbol: string, chainId: number | null): string {
  const tokenConfig = chainId
    ? Object.values(getChainConfig(chainId).tokens).find((token) => token.symbol === tokenSymbol)
    : null

  const decimals = tokenConfig?.decimals ?? 18
  try {
    const raw = BigInt(amount)
    const divisor = 10n ** BigInt(decimals)
    const whole = raw / divisor
    const fraction = raw % divisor
    const fractionText = fraction
      .toString()
      .padStart(decimals, '0')
      .slice(0, 2)
      .replace(/0+$/, '')

    return fractionText ? `${whole}.${fractionText}` : whole.toString()
  } catch {
    return amount
  }
}

function formatResetLabel(resetPeriodMin: number): string {
  const preset = RESET_PERIODS.find((item) => item.value === resetPeriodMin)
  if (preset) {
    return preset.label.toLowerCase().replace('one-time', 'total')
  }
  return resetPeriodMin > 0 ? `${resetPeriodMin}m` : 'total'
}

function buildSpendSummary(agent: DashboardAgentPreview): string {
  if (agent.allowances.length === 0) return 'No spend limits'

  const summaries = agent.allowances.slice(0, 2).map((allowance) => {
    const amount = formatAllowanceAmount(
      allowance.allowanceAmount,
      allowance.tokenSymbol,
      agent.safeChainId,
    )
    return `${amount} ${allowance.tokenSymbol}/${formatResetLabel(allowance.resetPeriodMin)}`
  })

  if (agent.allowances.length > 2) {
    summaries.push(`+${agent.allowances.length - 2} more`)
  }

  return summaries.join(' • ')
}

function ConnectedAgentsSection({
  agents,
  hasAnyAgents,
  hasAccounts,
  loading,
  unavailable,
  onRetry,
  onConnectAgent,
}: {
  agents: DashboardAgentPreview[]
  hasAnyAgents: boolean
  hasAccounts: boolean
  loading: boolean
  unavailable: boolean
  onRetry: () => void
  onConnectAgent: () => void
}) {
  return (
    <div className="rounded-[10px] border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-card)] overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--v2-border)] bg-[var(--v2-surface)] px-5 py-4">
        <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Connected agents</h2>
        <Link href="/agents" className="text-sm font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors">
          View all
        </Link>
      </div>

      {loading ? (
        <div className="divide-y divide-[var(--v2-border)]">
          {[0, 1, 2].map((item) => (
            <div key={item} className="flex items-center gap-3 px-5 py-4">
              <div className="h-10 w-10 rounded-xl bg-[var(--v2-surface-2)] animate-pulse" />
              <div className="min-w-0 flex-1">
                <div className="h-4 w-36 rounded bg-[var(--v2-surface-2)] animate-pulse" />
                <div className="mt-2 h-3 w-48 rounded bg-[var(--v2-surface-2)] animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      ) : unavailable ? (
        <div className="p-6">
          <EmptyPreview
            title="Agent preview unavailable"
            body="Haven could not verify which agents are connected right now."
            action={<Button variant="ghost" size="sm" onClick={onRetry}>Try again</Button>}
          />
        </div>
      ) : agents.length === 0 ? (
        <div className="p-6">
          <div className="rounded-lg border border-dashed border-[var(--v2-border-strong)] bg-[var(--v2-surface)] p-6 text-center">
            <p className="text-sm text-[var(--v2-ink)]">
              {hasAnyAgents ? 'No connected agents right now' : 'No agents connected yet'}
            </p>
            <p className="mt-2 text-xs text-[var(--v2-ink-2)]">
              {!hasAccounts
                ? 'Create a Haven account before connecting agents.'
                : hasAnyAgents
                ? 'Reconnect or create an agent to bring automated spending back online.'
                : 'Create your first agent to give it payment credentials and spend limits.'}
            </p>
            <div className="mt-4 flex items-center justify-center gap-3">
              {hasAccounts ? (
                <>
                  <Button onClick={onConnectAgent} size="sm">
                    Connect agent
                  </Button>
                  <Link href="/agents" className="text-sm font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors">
                    Go to Agents
                  </Link>
                </>
              ) : (
                <Link href="/accounts" className="text-sm font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors">
                  Go to Accounts
                </Link>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="divide-y divide-[var(--v2-border)]">
          {agents.slice(0, 5).map((agent) => (
            <Link
              key={agent.id}
              href={`/agents/${agent.id}`}
              className="flex items-center justify-between gap-4 px-5 py-4 hover:bg-[var(--v2-surface)] transition-colors"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-[var(--v2-brand-soft)] border border-[var(--v2-brand)]/15 flex items-center justify-center text-[var(--v2-brand)] flex-shrink-0">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-[var(--v2-ink)] truncate">{agent.name}</p>
                      <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${statusClasses(agent.status)}`}>
                        {statusLabel(agent.status)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-[var(--v2-ink-3)] truncate">{buildSpendSummary(agent)}</p>
                  </div>
                </div>
              </div>
              <svg className="w-4 h-4 text-[var(--v2-ink-3)] flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function DashboardHero({
  loading,
  unavailable,
  total,
  currency,
  changeAvailable,
  changeAmount,
  changePercent,
  hasAccounts,
  requiresOtherDevice,
  onSend,
  onReceive,
  onAddFunds,
}: {
  loading: boolean
  unavailable: boolean
  total: string
  currency: 'USD' | 'EUR'
  changeAvailable: boolean
  changeAmount: number
  changePercent: number
  hasAccounts: boolean
  requiresOtherDevice: boolean
  onSend: () => void
  onReceive: () => void
  onAddFunds: () => void
}) {
  return (
    <section
      className="relative overflow-hidden rounded-[24px] border shadow-[0_10px_24px_-22px_rgba(16,24,40,0.18)]"
      style={{ borderColor: '#E7E9F2', backgroundColor: '#F7F5FF' }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: 'linear-gradient(90deg, #F7F5FF 0%, #F3F0FF 55%, #F8F6FF 100%)' }}
      />
      <div className="relative grid gap-6 px-6 py-7 sm:px-8 sm:py-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div>
          <p className="text-sm font-medium text-[var(--v2-ink-2)]">Total balance</p>
          {loading ? (
            <div className="mt-3 h-12 w-56 rounded bg-[var(--v2-surface-2)] animate-pulse" />
          ) : unavailable ? (
            <p className="mt-2 text-4xl font-semibold tracking-tight text-[var(--v2-ink-3)] sm:text-5xl">
              Unavailable
            </p>
          ) : (
            <p className="mt-2 text-4xl font-semibold tracking-tight text-[var(--v2-ink)] v2-tabular sm:text-5xl">
              {total}
            </p>
          )}
          {changeAvailable ? (
            <p className={`mt-3 text-sm font-medium ${changeAmount >= 0 ? 'text-[var(--v2-success)]' : 'text-[var(--v2-danger)]'}`}>
              {formatSignedCurrency(changeAmount, currency)} ({formatPercent(changePercent)}) today
            </p>
          ) : (
            <p className="mt-3 text-sm text-[var(--v2-ink-3)]">
              Across all linked Haven accounts.
            </p>
          )}
        </div>

        {hasAccounts ? (
          requiresOtherDevice ? (
            <PasskeyOtherDeviceNotice className="max-w-sm" />
          ) : (
            <div className="flex flex-wrap gap-3">
              <Button onClick={onSend} size="lg">
                Send
              </Button>
              <Button onClick={onReceive} variant="ghost" size="lg">
                Receive
              </Button>
              <Button onClick={onAddFunds} variant="ghost" size="lg">
                Add funds
              </Button>
            </div>
          )
        ) : (
          <Button href="/accounts" size="lg">
            Create Haven account
          </Button>
        )}
      </div>
    </section>
  )
}

function MetricCard({
  label,
  value,
  footer,
  href,
  loading,
  unavailable,
}: {
  label: string
  value: string
  footer?: string
  href?: string
  loading?: boolean
  unavailable?: boolean
}) {
  const content = (
    <>
      <p className="text-xs font-medium text-[var(--v2-ink-3)]">{label}</p>
      {loading ? (
        <div className="mt-3 h-7 w-24 rounded bg-[var(--v2-surface-2)] animate-pulse" />
      ) : (
        <p className={`mt-2 text-2xl font-semibold tracking-tight v2-tabular ${unavailable ? 'text-[var(--v2-ink-3)]' : 'text-[var(--v2-ink)]'}`}>
          {unavailable ? 'Unavailable' : value}
        </p>
      )}
      {footer ? <p className="mt-2 text-xs text-[var(--v2-ink-3)]">{footer}</p> : null}
    </>
  )

  const className = 'block rounded-[10px] border border-[var(--v2-border)] bg-white p-5 shadow-[var(--v2-shadow-card)]'

  if (href) {
    return (
      <Link href={href} className={`${className} transition-colors hover:bg-[var(--v2-surface)]`}>
        {content}
      </Link>
    )
  }

  return <div className={className}>{content}</div>
}

function AttentionSection({
  approvalActionCount,
  hasOverviewError,
  onRetry,
}: {
  approvalActionCount: number
  hasOverviewError: boolean
  onRetry: () => void
}) {
  if (!hasOverviewError && approvalActionCount === 0) return null

  return (
    <section className="rounded-[10px] border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-card)]">
      <div className="border-b border-[var(--v2-border)] bg-[var(--v2-surface)] px-5 py-4">
        <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Needs attention</h2>
      </div>
      <div className="divide-y divide-[var(--v2-border)]">
        {hasOverviewError ? (
          <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium text-[var(--v2-danger)]">Dashboard data could not load</p>
              <p className="mt-1 text-sm text-[var(--v2-ink-2)]">
                Haven could not refresh balances, agents, and activity.
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={onRetry}>
              Try again
            </Button>
          </div>
        ) : null}
        {approvalActionCount > 0 ? (
          <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium text-[var(--v2-ink)]">
                {approvalActionCount} agent payment{approvalActionCount === 1 ? '' : 's'} {approvalActionCount === 1 ? 'needs' : 'need'} your action
              </p>
              <p className="mt-1 text-sm text-[var(--v2-ink-2)]">
                Review payments that are waiting before any money moves.
              </p>
            </div>
            <Button href="/approvals" size="sm">
              Open approvals
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function transactionTitle(tx: AggregatedTransaction): string {
  if (tx.direction === 'in') return 'Received payment'
  if (tx.source === 'x402' && tx.agentName) return `x402 payment by ${tx.agentName}`
  if (tx.source === 'x402') return 'x402 payment'
  if (tx.agentName) return `Agent payment by ${tx.agentName}`
  return 'Payment sent by you'
}

function transactionMovement(tx: AggregatedTransaction, resolveAddress: (address: string) => string | null) {
  const counterparty = tx.direction === 'in' ? tx.from : tx.to
  const label = tx.source === 'x402'
    ? parseX402Hostname(tx.x402ResourceUrl) ?? truncate(counterparty)
    : resolveAddress(counterparty) ?? truncate(counterparty)
  const from = tx.direction === 'in' ? label : tx.safeName
  const to = tx.direction === 'in' ? tx.safeName : label

  return <TransactionMovement from={from} to={to} />
}

function TransactionsSection({
  transactions,
  hasAccounts,
  loading,
  unavailable,
  onRetry,
  resolveAddress,
}: {
  transactions: AggregatedTransaction[]
  hasAccounts: boolean
  loading: boolean
  unavailable: boolean
  onRetry: () => void
  resolveAddress: (address: string) => string | null
}) {
  return (
    <div className="rounded-[10px] border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-card)] overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--v2-border)] bg-[var(--v2-surface)] px-5 py-4">
        <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Recent transactions</h2>
        <Link href="/transactions" className="text-sm font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors">
          View all
        </Link>
      </div>

      {loading ? (
        <div className="divide-y divide-[var(--v2-border)]">
          {[0, 1, 2].map((item) => (
            <div key={item} className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5">
              <div className="flex items-start gap-3">
                <div className="h-9 w-9 rounded-[10px] bg-[var(--v2-surface-2)] animate-pulse" />
                <div>
                  <div className="h-4 w-40 rounded bg-[var(--v2-surface-2)] animate-pulse" />
                  <div className="mt-2 h-3 w-56 rounded bg-[var(--v2-surface-2)] animate-pulse" />
                </div>
              </div>
              <div className="h-4 w-24 rounded bg-[var(--v2-surface-2)] animate-pulse sm:justify-self-end" />
            </div>
          ))}
        </div>
      ) : unavailable ? (
        <div className="p-6">
          <EmptyPreview
            title="Activity preview unavailable"
            body="Haven could not refresh recent payments right now."
            action={<Button variant="ghost" size="sm" onClick={onRetry}>Try again</Button>}
          />
        </div>
      ) : transactions.length === 0 ? (
        <div className="p-6">
          <div className="rounded-lg border border-dashed border-[var(--v2-border-strong)] bg-[var(--v2-surface)] p-6 text-center">
            <p className="text-sm text-[var(--v2-ink)]">No transactions yet</p>
            <p className="mt-2 text-xs text-[var(--v2-ink-2)]">
              {hasAccounts
                ? 'Receive funds or make your first payment to start building activity here.'
                : 'Create a Haven account to start tracking transactions.'}
            </p>
            <Link href={hasAccounts ? '/transactions' : '/accounts'} className="mt-4 inline-flex text-sm font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors">
              {hasAccounts ? 'Open transactions' : 'Go to accounts'}
            </Link>
          </div>
        </div>
      ) : (
        <div className="divide-y divide-[var(--v2-border)]">
          {transactions.slice(0, 5).map((tx) => (
            <Link
              key={`${tx.hash}-${tx.type}-${tx.safeId}`}
              href="/transactions"
              className="block"
            >
              <TransactionActivityRow
                title={transactionTitle(tx)}
                description={transactionMovement(tx, resolveAddress)}
                amount={`${tx.direction === 'in' ? '+' : '-'}${tx.valueFormatted} ${tx.asset}`}
                amountTone={tx.direction === 'in' ? 'success' : 'neutral'}
                status={tx.direction === 'in' ? 'Received' : 'Sent'}
                statusTone={tx.direction === 'in' ? 'success' : 'neutral'}
                timestamp={timeAgo(tx.timestamp * 1000)}
                direction={tx.direction}
              />
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function EmptyPreview({
  title,
  body,
  action,
}: {
  title: string
  body: string
  action?: ReactNode
}) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--v2-border-strong)] bg-[var(--v2-surface)] p-6 text-center">
      <p className="text-sm text-[var(--v2-ink)]">{title}</p>
      <p className="mt-2 text-xs text-[var(--v2-ink-2)]">{body}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

export default function DashboardClient() {
  const { user, activeSafe } = useAuth()
  const safes = user?.safes ?? []
  const { currency } = usePreferences()
  const { contacts, error: contactsError, resolveAddress } = useContacts()
  const { agents, loading: agentsLoading, refetch: refetchAgents } = useAgents()
  const {
    balances,
    loading: balancesLoading,
    refetch: refetchAggregatedBalances,
  } = useAggregatedBalances()
  const { data: overview, loading: overviewLoading, error: overviewError, refetch: refetchOverview } = useDashboardOverview()

  const hasAnyBalance = balances.some((balance) => {
    try {
      return BigInt(balance.balance) > 0n
    } catch {
      return false
    }
  })

  const onboardingStage: 'fund' | 'add-agent' | null =
    safes.length === 0 || balancesLoading
      ? null
      : !hasAnyBalance
        ? 'fund'
        : agentsLoading
          ? null
        : agents.length === 0
          ? 'add-agent'
          : null

  const defaultSafe = useMemo(
    () => activeSafe ?? safes.find((safe) => safe.is_default) ?? safes[0] ?? null,
    [activeSafe, safes],
  )

  const [createAgentOpen, setCreateAgentOpen] = useState(false)
  const [createAgentPreset, setCreateAgentPreset] = useState<'demo' | null>(null)
  const [pickerAction, setPickerAction] = useState<'send' | 'receive' | null>(null)
  const [sendOpen, setSendOpen] = useState(false)
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [comingSoonOpen, setComingSoonOpen] = useState(false)
  const [actionSafeId, setActionSafeId] = useState<string | null>(null)
  const [isGuideDismissed, setIsGuideDismissed] = useState(false)

  useEffect(() => {
    if (actionSafeId && safes.some((safe) => safe.id === actionSafeId)) return
    setActionSafeId(defaultSafe?.id ?? null)
  }, [actionSafeId, defaultSafe?.id, safes])

  const onboardingDismissKey =
    user && onboardingStage
      ? `haven_dashboard_onboarding_dismissed:${user.id}:${onboardingStage}`
      : null

  useEffect(() => {
    if (!onboardingDismissKey) {
      setIsGuideDismissed(false)
      return
    }

    setIsGuideDismissed(window.localStorage.getItem(onboardingDismissKey) === '1')
  }, [onboardingDismissKey])

  const selectedActionSafe = safes.find((safe) => safe.id === actionSafeId) ?? defaultSafe
  const actionGate = useSafeOperationGate({
    safeAddress: selectedActionSafe?.safe_address as Address | undefined,
    chainId: selectedActionSafe?.chain_id,
  })
  const requiresOtherDevice = actionGate.kind === 'passkey_on_other_device'
  const sendModalDataEnabled = sendOpen && Boolean(selectedActionSafe)
  const {
    balances: selectedSafeBalances,
    loading: selectedSafeBalancesLoading,
    error: selectedSafeBalancesError,
    refetch: refetchSelectedBalances,
  } = useBalances(
    selectedActionSafe?.safe_address ?? null,
    { enabled: sendModalDataEnabled },
  )
  const {
    details: selectedSafeDetails,
    loading: selectedSafeDetailsLoading,
    error: selectedSafeDetailsError,
  } = useSafeDetails(
    selectedActionSafe?.safe_address ?? null,
    { enabled: sendModalDataEnabled },
  )

  const totalFiat = currency === 'EUR' ? (overview?.totals.eur ?? 0) : (overview?.totals.usd ?? 0)
  const changeAmount = currency === 'EUR' ? (overview?.change.eurAmount ?? 0) : (overview?.change.usdAmount ?? 0)
  const changePercent = currency === 'EUR' ? (overview?.change.eurPercent ?? 0) : (overview?.change.usdPercent ?? 0)
  const monthlySpend = currency === 'EUR'
    ? (overview?.metrics.monthlyAgentSpendEur ?? 0)
    : (overview?.metrics.monthlyAgentSpendUsd ?? 0)
  const approvalActionCount = overview?.actionableApprovals ?? overview?.pendingApprovals ?? 0
  const overviewInitialLoading = overviewLoading && !overview
  const overviewUnavailable = Boolean(overviewError && !overview)
  const hasAttention = Boolean(overviewError || approvalActionCount > 0)
  const showOnboardingGuide = Boolean(onboardingStage && !requiresOtherDevice && !isGuideDismissed)
  const showTopAside = showOnboardingGuide || hasAttention

  function refreshDashboardData() {
    refetchOverview()
    refetchAgents()
    refetchAggregatedBalances()
    refetchSelectedBalances()
  }

  function openCreateAgent(preset: 'demo' | null = null) {
    setCreateAgentPreset(preset)
    setCreateAgentOpen(true)
  }

  function openHeroAction(action: 'send' | 'receive' | 'add-funds') {
    if (action === 'add-funds') {
      setComingSoonOpen(true)
      return
    }

    if (safes.length === 0) return

    if (safes.length > 1) {
      setPickerAction(action)
      return
    }

    setActionSafeId(defaultSafe?.id ?? null)
    if (action === 'send') setSendOpen(true)
    if (action === 'receive') setReceiveOpen(true)
  }

  function openReceiveForDefaultSafe() {
    if (!defaultSafe) return
    setActionSafeId(defaultSafe.id)
    setReceiveOpen(true)
  }

  function handleActionSafeSelected(safeId: string) {
    setActionSafeId(safeId)
    if (pickerAction === 'send') setSendOpen(true)
    if (pickerAction === 'receive') setReceiveOpen(true)
    setPickerAction(null)
  }

  function dismissOnboardingGuide() {
    if (!onboardingDismissKey) return
    window.localStorage.setItem(onboardingDismissKey, '1')
    setIsGuideDismissed(true)
  }

  return (
    <div className="max-w-6xl">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--v2-ink)]">Dashboard</h1>
        <p className="mt-1 text-sm text-[var(--v2-ink-2)]">
          Your money, agents, and actions at a glance.
        </p>
      </div>

      <div className={`mb-6 grid gap-4 ${showTopAside ? 'xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.42fr)]' : ''}`}>
        <DashboardHero
          loading={overviewInitialLoading}
          unavailable={overviewUnavailable}
          total={formatCurrency(totalFiat, currency)}
          currency={currency}
          changeAvailable={Boolean(overview?.change.available)}
          changeAmount={changeAmount}
          changePercent={changePercent}
          hasAccounts={safes.length > 0}
          requiresOtherDevice={requiresOtherDevice}
          onSend={() => openHeroAction('send')}
          onReceive={() => openHeroAction('receive')}
          onAddFunds={() => openHeroAction('add-funds')}
        />
        {showOnboardingGuide && onboardingStage ? (
          <DashboardOnboardingGuide
            stage={onboardingStage}
            safes={safes}
            onReceiveFunds={openReceiveForDefaultSafe}
            onAddAgent={() => openCreateAgent(null)}
            onDismiss={dismissOnboardingGuide}
          />
        ) : (
          <AttentionSection
            approvalActionCount={approvalActionCount}
            hasOverviewError={Boolean(overviewError)}
            onRetry={refetchOverview}
          />
        )}
      </div>

      {showOnboardingGuide && hasAttention ? (
        <div className="mb-6">
          <AttentionSection
            approvalActionCount={approvalActionCount}
            hasOverviewError={Boolean(overviewError)}
            onRetry={refetchOverview}
          />
        </div>
      ) : null}

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Agents connected"
          value={String(overview?.metrics.connectedAgents ?? 0)}
          href="/agents"
          loading={overviewInitialLoading}
          unavailable={overviewUnavailable}
        />
        <MetricCard
          label="Monthly agent spend"
          value={formatCompactCurrency(monthlySpend, currency)}
          footer="Current calendar month"
          loading={overviewInitialLoading}
          unavailable={overviewUnavailable}
        />
        <MetricCard
          label="Successful transactions"
          value={String(overview?.metrics.successfulTransactions ?? 0)}
          footer="All time"
          loading={overviewInitialLoading}
          unavailable={overviewUnavailable}
        />
        <MetricCard
          label="Active accounts"
          value={String(overview?.metrics.activeAccounts ?? safes.length)}
          href="/accounts"
          loading={false}
        />
      </div>

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
        <ConnectedAgentsSection
          agents={overview?.agents ?? []}
          hasAnyAgents={agents.length > 0}
          hasAccounts={safes.length > 0}
          loading={overviewInitialLoading}
          unavailable={overviewUnavailable}
          onRetry={refetchOverview}
          onConnectAgent={() => openCreateAgent(null)}
        />
        <TransactionsSection
          transactions={overview?.transactions ?? []}
          hasAccounts={safes.length > 0}
          loading={overviewInitialLoading}
          unavailable={overviewUnavailable}
          onRetry={refetchOverview}
          resolveAddress={resolveAddress}
        />
      </div>

      <CreateAgentModal
        open={createAgentOpen}
        onClose={() => {
          setCreateAgentOpen(false)
          setCreateAgentPreset(null)
        }}
        safeId={defaultSafe?.id ?? null}
        preset={createAgentPreset}
        onCreated={() => {
          refreshDashboardData()
        }}
      />

      <DashboardActionPickerModal
        open={pickerAction !== null}
        action={pickerAction ?? 'send'}
        safes={safes}
        onClose={() => setPickerAction(null)}
        onSelect={handleActionSafeSelected}
      />

      <SendModal
        open={sendOpen && Boolean(selectedActionSafe)}
        onClose={() => setSendOpen(false)}
        safeAddress={selectedActionSafe?.safe_address ?? ''}
        safeName={selectedActionSafe?.name}
        safeDetails={selectedSafeDetails}
        balances={selectedSafeBalances}
        onSuccess={() => {
          refreshDashboardData()
          setSendOpen(false)
        }}
        contacts={contacts}
        contactsError={contactsError}
        resolveAddress={resolveAddress}
        chainId={selectedActionSafe?.chain_id ?? 100}
        contextLoading={selectedSafeBalancesLoading || selectedSafeDetailsLoading}
        contextError={selectedSafeBalancesError ?? selectedSafeDetailsError}
      />

      <ReceiveFundsModal
        open={receiveOpen}
        safe={selectedActionSafe}
        onClose={() => setReceiveOpen(false)}
      />

      <ComingSoonModal
        open={comingSoonOpen}
        onClose={() => setComingSoonOpen(false)}
        onReceive={() => setReceiveOpen(true)}
      />
    </div>
  )
}
