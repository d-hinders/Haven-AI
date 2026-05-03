'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useAuth } from '@/context/AuthContext'
import { usePreferences } from '@/hooks/usePreferences'
import { useContacts } from '@/hooks/useContacts'
import { useAgents } from '@/hooks/useAgents'
import { useAggregatedBalances } from '@/hooks/useAggregatedPortfolio'
import { useDashboardOverview } from '@/hooks/useDashboardOverview'
import { useBalances } from '@/hooks/useBalances'
import { useSafeDetails } from '@/hooks/useSafeDetails'
import { RESET_PERIODS } from '@/lib/allowance-module'
import { getChainConfig } from '@/lib/chains'
import { truncate, timeAgo } from '@/lib/format'
import DashboardOnboardingGuide from '@/components/DashboardOnboardingGuide'
import CreateAgentModal from '@/components/CreateAgentModal'
import SendModal from '@/components/SendModal'
import DashboardActionPickerModal from '@/components/DashboardActionPickerModal'
import ReceiveFundsModal from '@/components/ReceiveFundsModal'
import ComingSoonModal from '@/components/ComingSoonModal'
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
  if (status === 'active') return 'bg-emerald-500/10 text-emerald-400'
  if (status === 'paused') return 'bg-amber-500/10 text-amber-300'
  return 'bg-white/[0.06] text-zinc-500'
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
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-5">
      <p className="text-sm text-zinc-400">{label}</p>
      {loading ? (
        <div className="mt-4 h-8 w-24 rounded bg-white/[0.06] animate-pulse" />
      ) : (
        <p className="mt-4 text-3xl font-semibold tracking-tight text-zinc-100">{value}</p>
      )}
      {href ? (
        <Link
          href={href}
          className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-indigo-300 hover:text-indigo-200 transition-colors"
        >
          View all
          <span aria-hidden="true">→</span>
        </Link>
      ) : footer ? (
        <p className="mt-4 text-sm text-zinc-500">{footer}</p>
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
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
        <h2 className="text-sm font-semibold text-zinc-100">Connected agents</h2>
        <Link href="/agents" className="text-sm font-medium text-indigo-300 hover:text-indigo-200 transition-colors">
          View all
        </Link>
      </div>

      {agents.length === 0 ? (
        <div className="p-6">
          <div className="rounded-lg border border-dashed border-white/[0.08] bg-white/[0.01] p-6 text-center">
            <p className="text-sm text-zinc-300">
              {hasAnyAgents ? 'No connected agents right now' : 'No agents connected yet'}
            </p>
            <p className="mt-2 text-xs text-zinc-500">
              {!hasAccounts
                ? 'Create or import an account before connecting agents.'
                : hasAnyAgents
                ? 'Reconnect or create an agent to bring automated spending back online.'
                : 'Create your first agent to give it payment credentials and spend limits.'}
            </p>
            <div className="mt-4 flex items-center justify-center gap-3">
              {hasAccounts ? (
                <>
                  <button
                    onClick={onConnectAgent}
                    className="rounded-lg bg-gradient-to-r from-indigo-500 to-violet-600 px-4 py-2 text-sm font-medium text-white hover:from-indigo-400 hover:to-violet-500 transition-all duration-200 shadow-lg shadow-indigo-500/20"
                  >
                    Connect agent
                  </button>
                  <Link href="/agents" className="text-sm font-medium text-indigo-300 hover:text-indigo-200 transition-colors">
                    Go to Agents
                  </Link>
                </>
              ) : (
                <Link href="/accounts" className="text-sm font-medium text-indigo-300 hover:text-indigo-200 transition-colors">
                  Go to Accounts
                </Link>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="divide-y divide-white/[0.06]">
          {agents.map((agent) => (
            <Link
              key={agent.id}
              href={`/agents/${agent.id}`}
              className="flex items-center justify-between gap-4 px-5 py-4 hover:bg-white/[0.03] transition-colors"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/15 flex items-center justify-center text-indigo-300 flex-shrink-0">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-zinc-100 truncate">{agent.name}</p>
                      <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${statusClasses(agent.status)}`}>
                        {statusLabel(agent.status)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-zinc-500 truncate">{buildSpendSummary(agent)}</p>
                  </div>
                </div>
              </div>
              <svg className="w-4 h-4 text-zinc-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
        <h2 className="text-sm font-semibold text-zinc-100">Recent transactions</h2>
        <Link href="/transactions" className="text-sm font-medium text-indigo-300 hover:text-indigo-200 transition-colors">
          View all
        </Link>
      </div>

      {transactions.length === 0 ? (
        <div className="p-6">
          <div className="rounded-lg border border-dashed border-white/[0.08] bg-white/[0.01] p-6 text-center">
            <p className="text-sm text-zinc-300">No transactions yet</p>
            <p className="mt-2 text-xs text-zinc-500">
              {hasAccounts
                ? 'Fund an account or make your first payment to start building activity here.'
                : 'Create or import an account to start tracking transactions.'}
            </p>
            <Link href={hasAccounts ? '/transactions' : '/accounts'} className="mt-4 inline-flex text-sm font-medium text-indigo-300 hover:text-indigo-200 transition-colors">
              {hasAccounts ? 'Open transactions' : 'Go to accounts'}
            </Link>
          </div>
        </div>
      ) : (
        <div className="divide-y divide-white/[0.06]">
          {transactions.map((tx) => (
            <Link
              key={`${tx.hash}-${tx.type}-${tx.safeId}`}
              href="/transactions"
              className="flex items-center justify-between gap-4 px-5 py-4 hover:bg-white/[0.03] transition-colors"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-100 truncate">
                  {transactionTitle(tx, resolveAddress)}
                </p>
                <p className="mt-1 text-xs text-zinc-500 truncate">
                  {transactionSubtitle(tx, resolveAddress)}
                </p>
              </div>
              <div className="text-right flex-shrink-0">
                <p className={`text-sm font-medium ${tx.direction === 'in' ? 'text-emerald-400' : 'text-zinc-100'}`}>
                  {tx.direction === 'in' ? '+' : '-'}
                  {tx.valueFormatted} {tx.asset}
                </p>
                <p className="mt-1 text-xs text-zinc-500">{timeAgo(tx.timestamp * 1000)}</p>
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

  useEffect(() => {
    if (guideSafeId && safes.some((safe) => safe.id === guideSafeId)) return
    setGuideSafeId(defaultSafe?.id ?? null)
  }, [defaultSafe?.id, guideSafeId, safes])

  useEffect(() => {
    if (actionSafeId && safes.some((safe) => safe.id === actionSafeId)) return
    setActionSafeId(defaultSafe?.id ?? null)
  }, [actionSafeId, defaultSafe?.id, safes])

  const selectedActionSafe = safes.find((safe) => safe.id === actionSafeId) ?? defaultSafe
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

  return (
    <div className="max-w-6xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-100">Dashboard</h1>
        <p className="mt-1 text-sm text-zinc-500">Overview across all accounts</p>
      </div>

      {overviewError && !overview && (
        <div className="mb-6 rounded-xl border border-red-400/20 bg-red-500/[0.04] px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-red-300">{overviewError}</p>
            <button
              onClick={refetchOverview}
              className="text-sm font-medium text-red-200 hover:text-white transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {(overview?.pendingApprovals ?? 0) > 0 && (
        <div className="mb-6 flex items-center gap-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.05] px-4 py-3">
          <svg className="w-4 h-4 text-amber-300 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <circle cx="12" cy="12" r="10" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4M12 16h.01" />
          </svg>
          <p className="text-sm text-amber-200">
            {overview?.pendingApprovals} payment{overview?.pendingApprovals === 1 ? '' : 's'} pending your approval
          </p>
          <Link href="/agents" className="ml-auto text-sm font-medium text-amber-100 hover:text-white transition-colors">
            Review
          </Link>
        </div>
      )}

      <div className="relative overflow-hidden rounded-2xl border border-white/[0.06] mb-6">
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'linear-gradient(135deg, rgba(99,102,241,0.16) 0%, rgba(79,70,229,0.10) 48%, rgba(15,23,42,0.35) 100%)',
          }}
        />
        <div className="relative px-6 py-7 sm:px-8 sm:py-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-300 mb-3">Total balance</p>
              {overviewLoading && !overview ? (
                <div className="h-12 w-52 rounded bg-white/[0.08] animate-pulse" />
              ) : (
                <p className="text-4xl sm:text-5xl font-semibold tracking-tight text-white">
                  {formatCurrency(totalFiat, currency)}
                </p>
              )}

              {overview?.change.available ? (
                <p className={`mt-4 text-sm font-medium ${changeAmount >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                  {formatSignedCurrency(changeAmount, currency)} ({formatPercent(changePercent)}) today
                </p>
              ) : (
                <p className="mt-4 text-sm text-zinc-400">
                  Balance change appears after your first full day of activity.
                </p>
              )}
            </div>

            {safes.length === 0 ? (
              <div className="flex flex-wrap gap-3">
                <Link
                  href="/accounts"
                  className="inline-flex items-center justify-center rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 px-5 py-3 text-sm font-medium text-white hover:from-indigo-400 hover:to-violet-500 transition-all duration-200 shadow-lg shadow-indigo-500/20"
                >
                  Create or import account
                </Link>
              </div>
            ) : (
              <div className="flex flex-wrap gap-3">
                <button
                  onClick={() => openHeroAction('send')}
                  className="inline-flex items-center justify-center rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 px-5 py-3 text-sm font-medium text-white hover:from-indigo-400 hover:to-violet-500 transition-all duration-200 shadow-lg shadow-indigo-500/20"
                >
                  Send
                </button>
                <button
                  onClick={() => openHeroAction('receive')}
                  className="inline-flex items-center justify-center rounded-xl border border-white/[0.12] bg-white/[0.03] px-5 py-3 text-sm font-medium text-zinc-100 hover:bg-white/[0.06] transition-colors"
                >
                  Receive
                </button>
                <button
                  onClick={() => openHeroAction('add-funds')}
                  className="inline-flex items-center justify-center rounded-xl border border-white/[0.12] bg-white/[0.03] px-5 py-3 text-sm font-medium text-zinc-100 hover:bg-white/[0.06] transition-colors"
                >
                  Add funds
                </button>
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

      {onboardingStage && (
        <DashboardOnboardingGuide
          stage={onboardingStage}
          safes={safes}
          selectedSafeId={guideSafeId}
          onSelectSafe={setGuideSafeId}
          onAddAgent={() => openCreateAgent(null)}
          onAddDemoAgent={() => openCreateAgent('demo')}
        />
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
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
