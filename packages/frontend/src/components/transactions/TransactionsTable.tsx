'use client'

import type { ReactNode } from 'react'
import { getExplorerUrl } from '@/lib/chains'
import { isMachinePaymentSource, parseX402Hostname, paymentSourceTitle } from '@/lib/transaction-labels'
import { timeAgo, truncate } from '@/lib/format'
import type { AggregatedTransaction } from '@/types/transactions'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ExternalDetailsLink, TransactionActivityRow, TransactionMovement } from '@/components/haven'

interface TransactionsTableProps {
  transactions: AggregatedTransaction[]
  loading: boolean
  error: string | null
  onRefresh: () => void
  resolveAddress?: (address: string) => string | null
  safeNamesByAddress?: Map<string, string>
  hasActiveFilters: boolean
}

export default function TransactionsTable({
  transactions,
  loading,
  error,
  onRefresh,
  resolveAddress,
  safeNamesByAddress,
  hasActiveFilters,
}: TransactionsTableProps) {
  if (loading) {
    return (
      <Card hover={false} className="overflow-hidden">
        {[0, 1, 2, 3].map((i) => (
          <TransactionActivitySkeleton key={i} />
        ))}
      </Card>
    )
  }

  if (error) {
    return (
      <EmptyState
        title="Could not load transaction history"
        body={error}
        action={
          <Button variant="ghost" size="sm" onClick={onRefresh}>
            Try again
          </Button>
        }
      />
    )
  }

  if (transactions.length === 0) {
    return (
      <EmptyState
        title={hasActiveFilters ? 'No activity matches these filters' : 'No activity yet'}
        body={
          hasActiveFilters
            ? 'Adjust or clear filters to widen the history.'
            : 'Payments and account funding activity will appear here.'
        }
        action={
          !hasActiveFilters ? (
            <Button href="/dashboard" variant="ghost" size="sm">
              Open dashboard
            </Button>
          ) : undefined
        }
      />
    )
  }

  return (
    <Card hover={false} className="overflow-hidden">
      <div className="border-b border-[var(--v2-border)] bg-[var(--v2-surface)] px-5 py-3">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 text-[11px] uppercase tracking-wide text-[var(--v2-ink-3)]">
          <span>Activity</span>
          <span className="text-right">Amount</span>
        </div>
      </div>
      <div className="divide-y divide-[var(--v2-border)]">
        {transactions.map((tx, index) => (
          <TransactionActivityRow
            key={`${tx.safeId}:${tx.hash}:${tx.type}:${index}`}
            title={transactionTitle(tx)}
            description={transactionMovement(tx, resolveAddress, safeNamesByAddress)}
            amount={transactionAmount(tx)}
            amountTone={tx.isError ? 'danger' : tx.direction === 'in' ? 'success' : 'neutral'}
            status={transactionStatus(tx)}
            statusTone={tx.isError ? 'danger' : tx.direction === 'in' ? 'success' : 'neutral'}
            timestamp={timeAgo(tx.timestamp * 1000)}
            direction={tx.direction}
            action={<ExternalDetailsLink href={getExplorerUrl(tx.chainId, 'tx', tx.hash)} />}
          />
        ))}
      </div>
    </Card>
  )
}

function TransactionActivitySkeleton() {
  return (
    <div className="flex items-center gap-3 border-b border-[var(--v2-border)] px-5 py-4 last:border-b-0">
      <div className="h-9 w-9 flex-shrink-0 rounded-[10px] bg-[var(--v2-surface-2)] animate-pulse" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="h-3 w-40 rounded bg-[var(--v2-surface-2)] animate-pulse" />
        <div className="h-2 w-56 max-w-full rounded bg-[var(--v2-surface-2)] animate-pulse" />
      </div>
      <div className="h-4 w-20 rounded bg-[var(--v2-surface-2)] animate-pulse" />
    </div>
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

function transactionStatus(tx: AggregatedTransaction): string {
  if (tx.isError) return 'Failed'
  return tx.direction === 'in' ? 'Received' : 'Sent'
}

function transactionAmount(tx: AggregatedTransaction): string {
  const sign = tx.direction === 'in' ? '+' : '-'
  return `${sign}${tx.valueFormatted} ${tx.asset}`
}

function transactionMovement(
  tx: AggregatedTransaction,
  resolveAddress?: (address: string) => string | null,
  safeNamesByAddress?: Map<string, string>,
): ReactNode {
  const counterparty = counterpartyLabel(tx, resolveAddress, safeNamesByAddress)
  const from = tx.direction === 'in' ? counterparty : tx.safeName
  const to = tx.direction === 'in' ? tx.safeName : counterparty

  return <TransactionMovement from={from} to={to} />
}

function counterpartyLabel(
  tx: AggregatedTransaction,
  resolveAddress?: (address: string) => string | null,
  safeNamesByAddress?: Map<string, string>,
): string {
  if (isMachinePaymentSource(tx.source)) {
    return parseX402Hostname(tx.x402ResourceUrl) ?? truncate(tx.to)
  }

  const address = tx.direction === 'in' ? tx.from : tx.to
  const safeName = safeNamesByAddress?.get(address.toLowerCase())
  const contactName = resolveAddress?.(address)

  return safeName ?? contactName ?? truncate(address)
}
