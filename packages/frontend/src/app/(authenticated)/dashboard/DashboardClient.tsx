'use client'

import { useEffect, useMemo, useState } from 'react'
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
import { truncate, timeAgo } from '@/lib/format'
import DashboardOnboardingGuide from '@/components/DashboardOnboardingGuide'
import CreateAgentModal from '@/components/CreateAgentModal'
import SendModal from '@/components/SendModal'
import DashboardActionPickerModal from '@/components/DashboardActionPickerModal'
import ReceiveFundsModal from '@/components/ReceiveFundsModal'
import ComingSoonModal from '@/components/ComingSoonModal'
import PasskeyOtherDeviceNotice from '@/components/PasskeyOtherDeviceNotice'
import { Button } from '@/components/ui/Button'
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

function MetricCard({
  label,
  value,
  footer,
  href,
  loading,
}: {
  label: string
  value: string
  footer?: string
  href?: string
  loading: boolean
}) {
  return (
    <div className="rounded-[10px] border border-[var(--v2-border)] bg-white p-5 shadow-[var(--v2-shadow-card)]">
      <p className="text-sm text-[var(--v2-ink-2)]">{label}</p>
      {loading ? (
        <div className="mt-4 h-8 w-24 rounded bg-[var(--v2-surface-2)] animate-pulse" />
      ) : (
        <p className="mt-4 text-3xl font-semibold tracking-tight text-[var(--v2-ink)]">{value}</p>
      )}
      {href ? (
        <Link
          href={href}
          className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors"
        >
          View all
          <span aria-hidden="true">→</span>
        </Link>
      ) : footer ? (
        <p className="mt-4 text-sm text-[var(--v2-ink-3)]">{footer}</p>
      ) : null}
    </div>
  )
}

function ConnectedAgentsSection({
  agents,
  hasAnyAgents,
  hasAccounts,
  onConnectAgent,
}: {
  agents: DashboardAgentPreview[]
  hasAnyAgents: boolean
  hasAccounts: boolean
  onConnectAgent: () => void
}) {
  return (
    <div className="rounded-[10px] border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-card)] overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--v2-border)]">
        <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Connected agents</h2>
        <Link href="/agents" className="text-sm font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors">
          View all
        </Link>
      </div>

      {agents.length === 0 ? (
        <div className="p-6">
          <div className="rounded-lg border border-dashed border-[var(--v2-border-strong)] bg-[var(--v2-surface)] p-6 text-center">
            <p className="text-sm text-[var(--v2-ink)]">
              {hasAnyAgents ? 'No connected agents right now' : 'No agents connected yet'}
            </p>
            <p className="mt-2 text-xs text-[var(--v2-ink-2)]">
              {!hasAccounts
                ? 'Create or import an account before connecting agents.'
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

function transactionTitle(tx: AggregatedTransaction, resolveAddress: (address: string) => string | null): string {
  if (tx.agentName) return tx.agentName
  const counterparty = tx.direction === 'in' ? tx.from : tx.to
  return resolveAddress(counterparty) ?? truncate(counterparty)
}

function transactionSubtitle(tx: AggregatedTransaction, resolveAddress: (address: string) => string | null): string {
  const counterparty = tx.direction === 'in' ? tx.from : tx.to
  const label = resolveAddress(counterparty) ?? truncate(counterparty)

  if (tx.agentName) {
    return `${tx.direction === 'in' ? 'Received from' : 'Paid'} ${label}`
  }

  return `${tx.direction === 'in' ? 'From' : 'To'} ${label}`
}

function TransactionDirectionIcon({ direction }: { direction: AggregatedTransaction['direction'] }) {
  const incoming = direction === 'in'

  return (
    <span
      aria-hidden="true"
      className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[10px] border ${
        incoming
          ? 'border-[var(--v2-success)]/20 bg-[var(--v2-success-soft)] text-[var(--v2-success)]'
          : 'border-[var(--v2-brand)]/15 bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]'
      }`}
    >
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        {incoming ? (
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14m0 0l-5-5m5 5l5-5" />
        ) : (
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5m0 0l-5 5m5-5l5 5" />
        )}
      </svg>
    </span>
  )
}

function TransactionsSection({
  transactions,
  hasAccounts,
  resolveAddress,
}: {
  transactions: AggregatedTransaction[]
  hasAccounts: boolean
  resolveAddress: (address: string) => string | null
}) {
  return (
    <div className="rounded-[10px] border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-card)] overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--v2-border)]">
        <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Recent transactions</h2>
        <Link href="/transactions" className="text-sm font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors">
          View all
        </Link>
      </div>

      {transactions.length === 0 ? (
        <div className="p-6">
          <div className="rounded-lg border border-dashed border-[var(--v2-border-strong)] bg-[var(--v2-surface)] p-6 text-center">
            <p className="text-sm text-[var(--v2-ink)]">No transactions yet</p>
            <p className="mt-2 text-xs text-[var(--v2-ink-2)]">
              {hasAccounts
                ? 'Fund an account or make your first payment to start building activity here.'
                : 'Create or import an account to start tracking transactions.'}
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
              className="flex items-center justify-between gap-4 px-5 py-4 hover:bg-[var(--v2-surface)] transition-colors"
            >
              <div className="flex min-w-0 items-center gap-3">
                <TransactionDirectionIcon direction={tx.direction} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-[var(--v2-ink)]">
                    {transactionTitle(tx, resolveAddress)}
                  </p>
                  <p className="mt-1 truncate text-xs text-[var(--v2-ink-3)]">
                    {transactionSubtitle(tx, resolveAddress)}
                  </p>
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <p className={`text-sm font-medium ${tx.direction === 'in' ? 'text-[var(--v2-success)]' : 'text-[var(--v2-ink)]'}`}>
                  {tx.direction === 'in' ? '+' : '-'}
                  {tx.valueFormatted} {tx.asset}
                </p>
                <p className="mt-1 text-xs text-[var(--v2-ink-3)]">{timeAgo(tx.timestamp * 1000)}</p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

export default function DashboardClient() {
  const { user, activeSafe } = useAuth()
  const safes = user?.safes ?? []
  const { currency } = usePreferences()
  const { contacts, resolveAddress } = useContacts()
  const { agents, refetch: refetchAgents } = useAgents()
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
        : agents.length === 0
          ? 'add-agent'
          : null

  const defaultSafe = useMemo(
    () => activeSafe ?? safes.find((safe) => safe.is_default) ?? safes[0] ?? null,
    [activeSafe, safes],
  )

  const [guideSafeId, setGuideSafeId] = useState<string | null>(null)
  const [createAgentOpen, setCreateAgentOpen] = useState(false)
  const [createAgentPreset, setCreateAgentPreset] = useState<'demo' | null>(null)
  const [pickerAction, setPickerAction] = useState<'send' | 'receive' | null>(null)
  const [sendOpen, setSendOpen] = useState(false)
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [comingSoonOpen, setComingSoonOpen] = useState(false)
  const [actionSafeId, setActionSafeId] = useState<string | null>(null)
  const [isGuideDismissed, setIsGuideDismissed] = useState(false)

  useEffect(() => {
    if (guideSafeId && safes.some((safe) => safe.id === guideSafeId)) return
    setGuideSafeId(defaultSafe?.id ?? null)
  }, [defaultSafe?.id, guideSafeId, safes])

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
  const { balances: selectedSafeBalances, refetch: refetchSelectedBalances } = useBalances(
    selectedActionSafe?.safe_address ?? null,
    { enabled: sendModalDataEnabled },
  )
  const { details: selectedSafeDetails } = useSafeDetails(
    selectedActionSafe?.safe_address ?? null,
    { enabled: sendModalDataEnabled },
  )

  const totalFiat = currency === 'EUR' ? (overview?.totals.eur ?? 0) : (overview?.totals.usd ?? 0)
  const changeAmount = currency === 'EUR' ? (overview?.change.eurAmount ?? 0) : (overview?.change.usdAmount ?? 0)
  const changePercent = currency === 'EUR' ? (overview?.change.eurPercent ?? 0) : (overview?.change.usdPercent ?? 0)
  const monthlySpend = currency === 'EUR'
    ? (overview?.metrics.monthlyAgentSpendEur ?? 0)
    : (overview?.metrics.monthlyAgentSpendUsd ?? 0)

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
        <p className="mt-1 text-sm text-[var(--v2-ink-2)]">Overview across all accounts</p>
      </div>

      {overviewError && !overview && (
        <div className="mb-6 rounded-xl border border-[var(--v2-danger)]/20 bg-[var(--v2-danger-soft)] px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-[var(--v2-danger)]">{overviewError}</p>
            <button
              onClick={refetchOverview}
              className="text-sm font-medium text-[var(--v2-danger)] hover:underline transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {(overview?.pendingApprovals ?? 0) > 0 && (
        <div className="mb-6 flex items-center gap-3 rounded-xl border border-[var(--v2-warning)]/20 bg-[var(--v2-warning-soft)] px-4 py-3">
          <svg className="w-4 h-4 text-[var(--v2-warning)] flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <circle cx="12" cy="12" r="10" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4M12 16h.01" />
          </svg>
          <p className="text-sm text-[var(--v2-warning)]">
            {overview?.pendingApprovals} payment{overview?.pendingApprovals === 1 ? '' : 's'} pending your approval
          </p>
          <Link href="/agents" className="ml-auto text-sm font-medium text-[var(--v2-warning)] hover:underline transition-colors">
            Review
          </Link>
        </div>
      )}

      {onboardingStage && !requiresOtherDevice && !isGuideDismissed && (
        <DashboardOnboardingGuide
          stage={onboardingStage}
          safes={safes}
          selectedSafeId={guideSafeId}
          onSelectSafe={setGuideSafeId}
          onAddAgent={() => openCreateAgent(null)}
          onDismiss={dismissOnboardingGuide}
        />
      )}

      <div className="relative mb-6 overflow-hidden rounded-[24px] border border-[#E7E9F2] bg-[#F7F5FF] shadow-[0_10px_24px_-22px_rgba(16,24,40,0.18)]">
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'linear-gradient(90deg, #F7F5FF 0%, #F3F0FF 55%, #F8F6FF 100%)',
          }}
        />
        <div className="relative px-6 py-7 sm:px-8 sm:py-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-sm font-medium text-[var(--v2-ink-2)] mb-3">Total balance</p>
              {overviewLoading && !overview ? (
                <div className="h-12 w-52 rounded bg-[var(--v2-surface-2)] animate-pulse" />
              ) : (
                <p className="text-4xl sm:text-5xl font-semibold tracking-tight text-[var(--v2-ink)]">
                  {formatCurrency(totalFiat, currency)}
                </p>
              )}

              {overview?.change.available ? (
                <p className={`mt-4 text-sm font-medium ${changeAmount >= 0 ? 'text-[var(--v2-success)]' : 'text-[var(--v2-danger)]'}`}>
                  {formatSignedCurrency(changeAmount, currency)} ({formatPercent(changePercent)}) today
                </p>
              ) : null}
            </div>

            {safes.length === 0 ? (
              <div className="flex flex-wrap gap-3">
                <Button href="/accounts" size="lg">
                  Create or import account
                </Button>
              </div>
            ) : requiresOtherDevice ? (
              <PasskeyOtherDeviceNotice className="max-w-sm" />
            ) : (
              <div className="flex flex-wrap gap-3">
                <Button onClick={() => openHeroAction('send')} size="lg">
                  Send
                </Button>
                <Button onClick={() => openHeroAction('receive')} variant="ghost" size="lg">
                  Receive
                </Button>
                <Button onClick={() => openHeroAction('add-funds')} variant="ghost" size="lg">
                  Add funds
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        <MetricCard
          label="Agents connected"
          value={String(overview?.metrics.connectedAgents ?? 0)}
          href="/agents"
          loading={overviewLoading && !overview}
        />
        <MetricCard
          label="Monthly agent spend"
          value={formatCompactCurrency(monthlySpend, currency)}
          footer="Current calendar month"
          loading={overviewLoading && !overview}
        />
        <MetricCard
          label="Successful transactions"
          value={String(overview?.metrics.successfulTransactions ?? 0)}
          footer="All time"
          loading={overviewLoading && !overview}
        />
        <MetricCard
          label="Active accounts"
          value={String(overview?.metrics.activeAccounts ?? safes.length)}
          href="/accounts"
          loading={overviewLoading && !overview}
        />
      </div>

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
        <ConnectedAgentsSection
          agents={overview?.agents ?? []}
          hasAnyAgents={agents.length > 0}
          hasAccounts={safes.length > 0}
          onConnectAgent={() => openCreateAgent(null)}
        />
        <TransactionsSection
          transactions={overview?.transactions ?? []}
          hasAccounts={safes.length > 0}
          resolveAddress={resolveAddress}
        />
      </div>

      <CreateAgentModal
        open={createAgentOpen}
        onClose={() => {
          setCreateAgentOpen(false)
          setCreateAgentPreset(null)
        }}
        safeId={guideSafeId}
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
        safeDetails={selectedSafeDetails}
        balances={selectedSafeBalances}
        onSuccess={() => {
          refreshDashboardData()
          setSendOpen(false)
        }}
        contacts={contacts}
        resolveAddress={resolveAddress}
        chainId={selectedActionSafe?.chain_id ?? 100}
      />

      <ReceiveFundsModal
        open={receiveOpen}
        safe={selectedActionSafe}
        onClose={() => setReceiveOpen(false)}
      />

      <ComingSoonModal
        open={comingSoonOpen}
        onClose={() => setComingSoonOpen(false)}
      />
    </div>
  )
}
