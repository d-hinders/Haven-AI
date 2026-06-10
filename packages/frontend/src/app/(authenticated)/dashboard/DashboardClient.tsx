'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import type { Address } from 'viem'
import { useAuth } from '@/context/AuthContext'
import { usePreferences } from '@/hooks/usePreferences'
import { useContacts } from '@/hooks/useContacts'
import { useAgents } from '@/hooks/useAgents'
import { useAggregatedBalances } from '@/hooks/useAggregatedPortfolio'
import { useCountUp } from '@/hooks/useCountUp'
import { useDashboardOverview } from '@/hooks/useDashboardOverview'
import { useBalances } from '@/hooks/useBalances'
import { useSafeDetails } from '@/hooks/useSafeDetails'
import { useSafeOperationGate } from '@/hooks/useSafeOperationGate'
import { RESET_PERIODS } from '@/lib/allowance-module'
import { formatAllowanceForToken } from '@/lib/allowance-format'
import { isMachinePaymentSource, parseX402Hostname, paymentSourceTitle } from '@/lib/transaction-labels'
import { truncate, timeAgo } from '@/lib/format'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'
import { agentStatusPresentation } from '@/lib/payment-status'
import { machinePaymentLifecyclePresentation } from '@/lib/machine-payment-lifecycle'
import { displayName } from '@/lib/user'
import DashboardOnboardingGuide from '@/components/DashboardOnboardingGuide'
import UsingYourAgentInfo from '@/components/UsingYourAgentInfo'
import ConnectAgent2Modal from '@/components/ConnectAgent2Modal'
import SendModal from '@/components/SendModal'
import DashboardActionPickerModal from '@/components/DashboardActionPickerModal'
import ReceiveFundsModal from '@/components/ReceiveFundsModal'
import ComingSoonModal from '@/components/ComingSoonModal'
import PasskeyOtherDeviceNotice from '@/components/PasskeyOtherDeviceNotice'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'
import { Row } from '@/components/ui/Row'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { useToast } from '@/components/ui/Toast'
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
    const amount = formatAllowanceForToken(
      allowance.allowanceAmount,
      agent.safeChainId,
      allowance.tokenSymbol,
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
        <div className="divide-y divide-[var(--v2-border)]" role="status" aria-busy="true" aria-live="polite" aria-label="Loading connected agents">
          {[0, 1, 2].map((item) => (
            <div key={item} className="flex items-center gap-3 px-5 h-[72px]">
              <div className="h-8 w-8 rounded-full bg-[var(--v2-surface-2)] animate-pulse" />
              <div className="min-w-0 flex-1">
                <div className="h-3.5 w-36 rounded bg-[var(--v2-surface-2)] animate-pulse" />
                <div className="mt-1.5 h-2.5 w-48 rounded bg-[var(--v2-surface-2)] animate-pulse" />
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
        <div className="divide-y divide-[var(--v2-border)] v2-animate-fade-in">
          {agents.slice(0, 5).map((agent) => {
            const status = agentStatusPresentation(agent.status)
            return (
              <Row
                key={agent.id}
                href={`/agents/${agent.id}`}
                // Robot mark matches the sidebar's "agents" icon so the
                // dashboard and nav read as the same system.
                leading={<AgentMarkIcon />}
                leadingTone="brand"
                title={
                  <span className="flex items-center gap-2">
                    <span className="truncate">{agent.name}</span>
                    <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                  </span>
                }
                subtitle={buildSpendSummary(agent)}
                trailing={
                  <svg className="w-4 h-4 text-[var(--v2-ink-3)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                }
                className="h-[72px] px-5"
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

function DashboardHero({
  loading,
  unavailable,
  totalFiat,
  currency,
  changeAvailable,
  changeAmount,
  changePercent,
  hasAccounts,
  hasFunds,
  fundingStateKnown,
  watchingForDeposit,
  requiresOtherDevice,
  onSend,
  onReceive,
  onAddFunds,
}: {
  loading: boolean
  unavailable: boolean
  totalFiat: number
  currency: 'USD' | 'EUR'
  changeAvailable: boolean
  changeAmount: number
  changePercent: number
  hasAccounts: boolean
  hasFunds: boolean
  fundingStateKnown: boolean
  watchingForDeposit: boolean
  requiresOtherDevice: boolean
  onSend: () => void
  onReceive: () => void
  onAddFunds: () => void
}) {
  // Animate the balance from 0 → totalFiat on first paint after data loads.
  // Subsequent changes (currency switches, polled refresh) snap instantly.
  // Respects prefers-reduced-motion via the hook.
  const animatedTotal = useCountUp(totalFiat, { enabled: !loading && !unavailable })

  return (
    <section
      className="relative overflow-hidden rounded-[24px] border border-[var(--v2-border-anchor)] bg-[var(--v2-surface-anchor)] shadow-[var(--v2-shadow-card-raised)]"
    >
      {/*
        Subtle ambient drift on the hero's gradient backdrop — the v2-mesh-drift
        keyframe in globals.css alternates ~2% translation over 18s. Adds a
        quiet sense of "alive" without being noticeable. Disabled by the same
        keyframe under prefers-reduced-motion.

        The backdrop extends 6% past the parent on every side so the drift's
        translation never pulls the layer off-edge and exposes the underlying
        anchor surface. The parent's `overflow-hidden` + rounded corners clip
        the buffer away.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-[6%] v2-mesh-drift"
        style={{ background: 'var(--v2-surface-hero)' }}
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
              {formatCurrency(animatedTotal, currency)}
            </p>
          )}
          {/*
            Three meta-line states under the headline number:
            1. Watching for a deposit (user opened Receive earlier, balance
               still 0) — shows a soft brand-tinted pill with a pulse so the
               user knows the dashboard is actively listening.
            2. Funded with change data — show today's signed % change.
            3. Funded without change data, OR no change available — quiet
               "Across all linked Haven accounts." caption.
          */}
          {watchingForDeposit ? (
            <p className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-[var(--v2-brand)]">
              <span
                aria-hidden="true"
                className="inline-flex h-1.5 w-1.5 rounded-full bg-[var(--v2-brand)] animate-pending-pulse"
              />
              Watching for incoming deposits…
            </p>
          ) : changeAvailable ? (
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
          ) : !fundingStateKnown || hasFunds ? (
            // Funded: Send is primary, Receive + Add funds support.
            // While balances are still loading, keep this neutral action order
            // so the hero does not briefly claim the account needs funds.
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
          ) : (
            // Unfunded: Receive becomes the primary action — Send is useless
            // with $0 and a confusing offer. We keep Send visible but ghost
            // so a user who already has off-flow plans can still find it.
            <div className="flex flex-wrap gap-3">
              <Button onClick={onReceive} size="lg">
                Receive funds
              </Button>
              <Button onClick={onAddFunds} variant="ghost" size="lg">
                Add funds
              </Button>
              <Button onClick={onSend} variant="ghost" size="lg">
                Send
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
  icon,
  loading,
  unavailable,
}: {
  label: string
  value: string
  footer?: string
  href?: string
  icon?: ReactNode
  loading?: boolean
  unavailable?: boolean
}) {
  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-[var(--v2-ink-3)]">{label}</p>
        {icon ? (
          <span
            aria-hidden="true"
            // Icon adopts brand color on hover via the group class on the parent link.
            className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-[var(--v2-ink-3)] transition-colors duration-150 group-hover:text-[var(--v2-brand)]"
          >
            {icon}
          </span>
        ) : null}
      </div>
      {loading ? (
        <div className="mt-3 h-7 w-24 rounded bg-[var(--v2-surface-2)] animate-pulse" />
      ) : (
        <p className={`mt-2 text-2xl font-semibold tracking-tight v2-tabular v2-animate-fade-in ${unavailable ? 'text-[var(--v2-ink-3)]' : 'text-[var(--v2-ink)]'}`}>
          {unavailable ? 'Unavailable' : value}
        </p>
      )}
      {footer ? <p className="mt-2 text-xs text-[var(--v2-ink-3)]">{footer}</p> : null}
    </>
  )

  // Every metric card is interactive now — the four-card grid was inconsistent
  // before (two had href, two didn't). The hover lift (raised shadow + 1px
  // translate) makes the affordance obvious and matches the Stripe-style
  // hover treatment used on the dashboard hero.
  const baseClass =
    'group block rounded-[10px] border border-[var(--v2-border)] bg-white p-5 shadow-[var(--v2-shadow-card)] transition-all duration-200 ease-out motion-reduce:transition-none motion-reduce:hover:translate-y-0'
  const hoverClass =
    'hover:-translate-y-px hover:shadow-[var(--v2-shadow-card-raised)] hover:border-[var(--v2-border-strong)]'

  if (href) {
    return (
      <Link href={href} className={`${baseClass} ${hoverClass}`}>
        {content}
      </Link>
    )
  }
  return <div className={baseClass}>{content}</div>
}

// ── Metric card icons (1.5 stroke, 14px, currentColor) ───────────────────
// These match the sidebar / Row visual language. AgentMarkIcon mirrors the
// sidebar's "agents" robot mark so the dashboard reads the same as the nav.

function AgentMarkIcon() {
  return (
    <svg className="w-full h-full" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <rect x="5" y="8" width="14" height="10" rx="3" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v3M9.5 12h.01M14.5 12h.01M9 16h6" />
    </svg>
  )
}

function SpendIcon() {
  return (
    <svg className="w-full h-full" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m4-9.5c0-1.38-1.79-2.5-4-2.5s-4 1.12-4 2.5 1.79 2.5 4 2.5 4 1.12 4 2.5-1.79 2.5-4 2.5-4-1.12-4-2.5" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg className="w-full h-full" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
    </svg>
  )
}

function WalletIcon() {
  return (
    <svg className="w-full h-full" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9v3m13.5 3.75h.008v.008H16.5v-.008z" />
    </svg>
  )
}

function EmptyTransactionsIcon() {
  // Arrows-in-out icon — mirrors the sidebar's "transactions" mark so the
  // empty state belongs to the same visual family.
  return (
    <svg className="w-full h-full" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 7.5h11.25m0 0L15.75 4.5m3 3l-3 3M16.5 16.5H5.25m0 0l3-3m-3 3l3 3" />
    </svg>
  )
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
    // Anchor elevation — the "Needs attention" panel is the second-most
    // important surface on the dashboard after the balance hero. The cooler
    // off-white surface and brand-tinted hairline give it presence without
    // competing with the hero. Slide-in on mount so the arrival feels
    // intentional rather than abrupt (it's an interruption element).
    <Card as="article" elevation="anchor" className="overflow-hidden v2-animate-slide-in">
      <div className="border-b border-[var(--v2-border)] px-5 py-4">
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
    </Card>
  )
}

function transactionTitle(tx: AggregatedTransaction): string {
  if (tx.direction === 'in') return 'Received payment'
  const sourceTitle = paymentSourceTitle(tx.source)
  if (sourceTitle && tx.agentName) return `${sourceTitle} by ${tx.agentName}`
  if (sourceTitle) return sourceTitle
  if (tx.agentName) return `Agent payment by ${tx.agentName}`
  return 'Payment sent by you'
}

function transactionMovement(tx: AggregatedTransaction, resolveAddress: (address: string) => string | null) {
  const counterparty = tx.direction === 'in' ? tx.from : tx.to
  const label = isMachinePaymentSource(tx.source)
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
        <div className="divide-y divide-[var(--v2-border)]" role="status" aria-busy="true" aria-live="polite" aria-label="Loading recent transactions">
          {[0, 1, 2].map((item) => (
            <div key={item} className="grid gap-3 px-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5 h-[72px]">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-[10px] bg-[var(--v2-surface-2)] animate-pulse" />
                <div>
                  <div className="h-3.5 w-40 rounded bg-[var(--v2-surface-2)] animate-pulse" />
                  <div className="mt-1.5 h-2.5 w-56 rounded bg-[var(--v2-surface-2)] animate-pulse" />
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
          <EmptyState
            tone="brand"
            icon={<EmptyTransactionsIcon />}
            title="No transactions yet"
            body={
              hasAccounts
                ? 'Receive funds or make your first payment to start building activity here.'
                : 'Create a Haven account to start tracking transactions.'
            }
            action={
              <Button
                href={hasAccounts ? '/transactions' : '/accounts'}
                variant="ghost"
                size="sm"
              >
                {hasAccounts ? 'Open transactions' : 'Go to accounts'}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="divide-y divide-[var(--v2-border)] v2-animate-fade-in">
          {transactions.slice(0, 5).map((tx) => {
            const lifecycle = machinePaymentLifecyclePresentation(tx)
            return (
              <Link
                key={`${tx.hash}-${tx.type}-${tx.safeId}`}
                href="/transactions"
                className="block"
              >
                <TransactionActivityRow
                  title={transactionTitle(tx)}
                  description={transactionMovement(tx, resolveAddress)}
                  amount={`${tx.direction === 'in' ? '+' : '-'}${tx.valueFormatted} ${tx.asset}`}
                  amountTone={
                    tx.isError ? 'danger' : tx.direction === 'in' ? 'success' : 'neutral'
                  }
                  status={lifecycle?.label ?? (tx.isError ? 'Failed' : tx.direction === 'in' ? 'Received' : 'Sent')}
                  statusTone={lifecycle?.tone ?? (
                    tx.isError ? 'danger' : tx.direction === 'in' ? 'success' : 'neutral'
                  )}
                  timestamp={timeAgo(tx.timestamp * 1000)}
                  direction={tx.direction}
                  density="compact"
                />
              </Link>
            )
          })}
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
  const { toast } = useToast()
  const safes = user?.safes ?? []
  const { currency } = usePreferences()
  const { contacts, error: contactsError, resolveAddress } = useContacts()
  const { agents, loading: agentsLoading, refetch: refetchAgents } = useAgents()
  const {
    balances,
    loading: balancesLoading,
    error: balancesError,
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

  // Each onboarding step is computed independently from real state so the
  // user can complete them in any order. The guide always renders the
  // canonical Fund → Agent → First payment ordering but a step completed
  // out of order shows as done regardless.
  const fundingStateKnown = safes.length > 0 && !balancesLoading && !balancesError
  const dataReady = fundingStateKnown && !agentsLoading
  const hasFunds = fundingStateKnown && hasAnyBalance
  const hasAgents = dataReady && agents.length > 0
  const overviewInitialLoading = overviewLoading && !overview
  const firstAgentPaymentKnown = Boolean(overview?.onboardingProgress)
  const hasFirstAgentPayment = Boolean(
    overview?.onboardingProgress?.hasFirstAgentPayment,
  )
  const setupProgressReady =
    dataReady &&
    (!hasFunds || !hasAgents || firstAgentPaymentKnown)
  const allOnboardingComplete =
    setupProgressReady && hasFunds && hasAgents && hasFirstAgentPayment

  const defaultSafe = useMemo(
    () => activeSafe ?? safes.find((safe) => safe.is_default) ?? safes[0] ?? null,
    [activeSafe, safes],
  )

  const [connectAgentOpen, setConnectAgentOpen] = useState(false)
  const [pickerAction, setPickerAction] = useState<'send' | 'receive' | null>(null)
  const [sendOpen, setSendOpen] = useState(false)
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [comingSoonOpen, setComingSoonOpen] = useState(false)
  const [agentUsageOpen, setAgentUsageOpen] = useState(false)
  // Set true the first time the user opens Receive in this session. Combined
  // with !hasFunds it drives the hero's "Watching for incoming deposits…"
  // hint so the user knows the dashboard is actively listening.
  const [hasOpenedReceive, setHasOpenedReceive] = useState(false)
  const [actionSafeId, setActionSafeId] = useState<string | null>(null)
  // In-progress dismissal is session-only — refreshing brings the checklist
  // back so we keep nudging the user toward completing setup.
  const [inProgressDismissed, setInProgressDismissed] = useState(false)
  // Setup-complete dismissal IS persisted — once the user has done all three
  // steps and dismissed the celebration, we don't show it again on reload.
  const [completeDismissalState, setCompleteDismissalState] = useState<{
    userId: string | null
    dismissed: boolean
  }>({ userId: null, dismissed: false })
  const completeDismissalReady =
    Boolean(user?.id) && completeDismissalState.userId === user?.id
  const completeDismissed = completeDismissalReady
    ? completeDismissalState.dismissed
    : false

  useEffect(() => {
    if (actionSafeId && safes.some((safe) => safe.id === actionSafeId)) return
    setActionSafeId(defaultSafe?.id ?? null)
  }, [actionSafeId, defaultSafe?.id, safes])

  // Read the persisted setup-complete dismissal once the user is known.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!user?.id) {
      setCompleteDismissalState({ userId: null, dismissed: false })
      return
    }
    const stored = window.localStorage.getItem(`haven-onboarding-complete-dismissed:${user.id}`)
    setCompleteDismissalState({ userId: user.id, dismissed: stored === '1' })
  }, [user?.id])

  // If the user makes progress after dismissing the in-progress checklist,
  // bring it back so they see the next step. We track the completed count in
  // a ref and reset the dismiss whenever it grows.
  const completedCount = (hasFunds ? 1 : 0) + (hasAgents ? 1 : 0) + (hasFirstAgentPayment ? 1 : 0)
  const previousCompletedRef = useRef(completedCount)
  useEffect(() => {
    if (completedCount > previousCompletedRef.current && inProgressDismissed) {
      setInProgressDismissed(false)
    }
    previousCompletedRef.current = completedCount
  }, [completedCount, inProgressDismissed])

  // Celebrate the first-fund moment: when hasFunds flips false → true, fire
  // a success toast. Only after data is ready, to avoid firing on initial
  // mount before the balances hook has resolved.
  const previousFundedRef = useRef<boolean | null>(null)
  useEffect(() => {
    if (!dataReady) return
    if (previousFundedRef.current === false && hasFunds) {
      toast.success('Funds received — your agents can spend now')
    }
    previousFundedRef.current = hasFunds
  }, [dataReady, hasFunds, toast])

  // First arrival from the onboarding wizard — fire a single welcome toast
  // so the moment of arrival nods to the achievement without shouting. The
  // session flag is set by the wizard's "Go to dashboard" CTA and cleared
  // here so a refresh later in the same session doesn't re-fire.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!user) return
    let justOnboarded = false
    try {
      justOnboarded = window.sessionStorage.getItem('haven-just-onboarded') === '1'
      if (justOnboarded) {
        window.sessionStorage.removeItem('haven-just-onboarded')
      }
    } catch {
      // sessionStorage can throw in private mode — bail out silently. No
      // user-facing impact, the dashboard still renders.
      return
    }
    if (!justOnboarded) return
    const firstName = displayName(user).split(' ')[0]
    toast.success(`Welcome to Haven, ${firstName} — your account is live.`)
    // Intentionally fire once per session. The dependency array is empty
    // because we want this effect to run only on first mount after
    // arriving from onboarding; user identity is captured in the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    { enabled: sendModalDataEnabled, chainId: selectedActionSafe?.chain_id },
  )
  const {
    details: selectedSafeDetails,
    loading: selectedSafeDetailsLoading,
    error: selectedSafeDetailsError,
  } = useSafeDetails(
    selectedActionSafe?.safe_address ?? null,
    { enabled: sendModalDataEnabled, chainId: selectedActionSafe?.chain_id },
  )

  const totalFiat = currency === 'EUR' ? (overview?.totals.eur ?? 0) : (overview?.totals.usd ?? 0)
  const changeAmount = currency === 'EUR' ? (overview?.change.eurAmount ?? 0) : (overview?.change.usdAmount ?? 0)
  const changePercent = currency === 'EUR' ? (overview?.change.eurPercent ?? 0) : (overview?.change.usdPercent ?? 0)
  const monthlySpend = currency === 'EUR'
    ? (overview?.metrics.monthlyAgentSpendEur ?? 0)
    : (overview?.metrics.monthlyAgentSpendUsd ?? 0)
  const approvalActionCount = overview?.actionableApprovals ?? overview?.pendingApprovals ?? 0
  const overviewUnavailable = Boolean(overviewError && !overview)
  const hasAttention = Boolean(overviewError || approvalActionCount > 0)
  // Render the guide whenever the user has at least one Safe and either:
  // (a) they have unfinished steps and haven't dismissed the checklist, OR
  // (b) they've just finished all three steps and haven't dismissed the celebration.
  const showOnboardingGuide =
    setupProgressReady &&
    completeDismissalReady &&
    !requiresOtherDevice &&
    (allOnboardingComplete ? !completeDismissed : !inProgressDismissed)
  const showTopAside = hasAttention

  function refreshDashboardData() {
    refetchOverview()
    refetchAgents()
    refetchAggregatedBalances()
    refetchSelectedBalances()
  }

  function openConnectAgent() {
    setConnectAgentOpen(true)
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
    if (action === 'receive') {
      setHasOpenedReceive(true)
      setReceiveOpen(true)
    }
  }

  function openReceiveForDefaultSafe() {
    if (!defaultSafe) return
    setActionSafeId(defaultSafe.id)
    setHasOpenedReceive(true)
    setReceiveOpen(true)
  }

  function handleActionSafeSelected(safeId: string) {
    setActionSafeId(safeId)
    if (pickerAction === 'send') setSendOpen(true)
    if (pickerAction === 'receive') setReceiveOpen(true)
    setPickerAction(null)
  }

  function dismissInProgressGuide() {
    setInProgressDismissed(true)
  }

  function dismissCompleteBanner() {
    setCompleteDismissalState({ userId: user?.id ?? null, dismissed: true })
    if (typeof window !== 'undefined' && user?.id) {
      window.localStorage.setItem(`haven-onboarding-complete-dismissed:${user.id}`, '1')
    }
  }

  const heroPanel = (
    <DashboardHero
      loading={overviewInitialLoading}
      unavailable={overviewUnavailable}
      totalFiat={totalFiat}
      currency={currency}
      changeAvailable={Boolean(overview?.change.available)}
      changeAmount={changeAmount}
      changePercent={changePercent}
      hasAccounts={safes.length > 0}
      hasFunds={hasFunds}
      fundingStateKnown={fundingStateKnown}
      watchingForDeposit={fundingStateKnown && !hasFunds && hasOpenedReceive}
      requiresOtherDevice={requiresOtherDevice}
      onSend={() => openHeroAction('send')}
      onReceive={() => openHeroAction('receive')}
      onAddFunds={() => openHeroAction('add-funds')}
    />
  )

  const attentionPanel = (
    <AttentionSection
      approvalActionCount={approvalActionCount}
      hasOverviewError={Boolean(overviewError)}
      onRetry={refetchOverview}
    />
  )

  const metricsGrid = (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard
        label="Agents connected"
        value={String(overview?.metrics.connectedAgents ?? 0)}
        href="/agents"
        icon={<AgentMarkIcon />}
        loading={overviewInitialLoading}
        unavailable={overviewUnavailable}
      />
      <MetricCard
        label="Monthly agent spend"
        value={formatCompactCurrency(monthlySpend, currency)}
        footer="Current calendar month"
        href="/transactions?direction=out"
        icon={<SpendIcon />}
        loading={overviewInitialLoading}
        unavailable={overviewUnavailable}
      />
      <MetricCard
        label="Successful transactions"
        value={String(overview?.metrics.successfulTransactions ?? 0)}
        footer="All time"
        href="/transactions"
        icon={<CheckIcon />}
        loading={overviewInitialLoading}
        unavailable={overviewUnavailable}
      />
      <MetricCard
        label="Active accounts"
        value={String(overview?.metrics.activeAccounts ?? safes.length)}
        href="/accounts"
        icon={<WalletIcon />}
        loading={false}
      />
    </div>
  )

  const activityGrid = (
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
      <ConnectedAgentsSection
        agents={overview?.agents ?? []}
        hasAnyAgents={agents.length > 0}
        hasAccounts={safes.length > 0}
        loading={overviewInitialLoading}
        unavailable={overviewUnavailable}
        onRetry={refetchOverview}
        onConnectAgent={openConnectAgent}
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
  )

  return (
    <div className="max-w-6xl">
      <PageHeader title="Dashboard" subtitle="Your money, agents, and actions at a glance." />

      {/*
        Hide metrics + activity only for a brand-new user (no progress at
        all). Once any step is done, the full dashboard renders alongside
        the checklist so the user can see their progress against the rest
        of the dashboard.
      */}
      {(() => {
        const showGuide = showOnboardingGuide
        // Focused first-run view: hero + checklist only, no metrics/activity.
        // Triggered when the user hasn't funded their account yet — agent and
        // payment steps need funded state to be useful.
        const isFocusedView = showGuide && !hasFunds
        const guide = showGuide ? (
          <DashboardOnboardingGuide
            hasFunds={hasFunds}
            hasAgents={hasAgents}
            hasFirstAgentPayment={hasFirstAgentPayment}
            onReceiveFunds={openReceiveForDefaultSafe}
            onAddAgent={openConnectAgent}
            onShowAgentUsage={() => setAgentUsageOpen(true)}
            onDismiss={dismissInProgressGuide}
            onDismissComplete={dismissCompleteBanner}
            inProgressDismissed={inProgressDismissed}
            completeDismissed={completeDismissed}
          />
        ) : null

        if (isFocusedView) {
          return (
            <div className="space-y-6">
              {heroPanel}
              {hasAttention ? attentionPanel : null}
              {guide}
            </div>
          )
        }

        return (
          <div className="space-y-6">
            <div
              className={`grid items-start gap-4 ${
                showTopAside ? 'xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.42fr)]' : ''
              }`}
            >
              {heroPanel}
              {attentionPanel}
            </div>
            {guide}
            {metricsGrid}
            {activityGrid}
          </div>
        )
      })()}

      <ConnectAgent2Modal
        open={connectAgentOpen}
        onClose={() => {
          setConnectAgentOpen(false)
        }}
        safeId={defaultSafe?.id ?? null}
        onSetupUpdated={() => {
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

      {sendOpen && selectedActionSafe && (
        <SendModal
          open
          onClose={() => setSendOpen(false)}
          safeAddress={selectedActionSafe.safe_address}
          safeName={selectedActionSafe.name}
          safeDetails={selectedSafeDetails}
          balances={selectedSafeBalances}
          onSuccess={() => {
            refreshDashboardData()
            setSendOpen(false)
          }}
          contacts={contacts}
          contactsError={contactsError}
          resolveAddress={resolveAddress}
          chainId={selectedActionSafe.chain_id ?? DEFAULT_CHAIN_ID}
          contextLoading={selectedSafeBalancesLoading || selectedSafeDetailsLoading}
          contextError={selectedSafeBalancesError ?? selectedSafeDetailsError}
        />
      )}

      <ReceiveFundsModal
        open={receiveOpen}
        safe={selectedActionSafe}
        onClose={() => setReceiveOpen(false)}
      />

      <ComingSoonModal
        open={comingSoonOpen}
        onClose={() => setComingSoonOpen(false)}
        onReceive={() => {
          setHasOpenedReceive(true)
          setReceiveOpen(true)
        }}
      />

      <UsingYourAgentInfo
        open={agentUsageOpen}
        onClose={() => setAgentUsageOpen(false)}
      />
    </div>
  )
}
