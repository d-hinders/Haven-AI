'use client'

import Link from 'next/link'
import { getExplorerUrl } from '@/lib/chains'
import { timeAgo, truncate } from '@/lib/format'
import type { AggregatedTransaction } from '@/types/transactions'

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
      <div className="space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="flex items-center gap-3 rounded-md border border-[var(--v2-border)] bg-white p-3"
          >
            <div className="h-7 w-7 rounded-full bg-[var(--v2-surface-2)] animate-pulse" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-40 rounded bg-[var(--v2-surface-2)] animate-pulse" />
              <div className="h-2 w-28 rounded bg-[var(--v2-surface-2)] animate-pulse" />
            </div>
            <div className="h-4 w-16 rounded bg-[var(--v2-surface-2)] animate-pulse" />
          </div>
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-32 flex-col items-center justify-center rounded-md border border-dashed border-[var(--v2-danger)]/25 bg-[var(--v2-danger-soft)]">
        <span className="mb-2 text-sm text-[var(--v2-danger)]">{error}</span>
        <button
          onClick={onRefresh}
          className="text-xs font-medium text-[var(--v2-danger)] underline underline-offset-2 hover:opacity-80"
        >
          Retry
        </button>
      </div>
    )
  }

  if (transactions.length === 0) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center rounded-[10px] border border-dashed border-[var(--v2-border-strong)] bg-[var(--v2-surface)] px-6 text-center">
        <span className="mb-1 text-sm font-medium text-[var(--v2-ink)]">
          {hasActiveFilters ? 'No transactions match these filters' : 'No transactions yet'}
        </span>
        <span className="mb-4 text-xs text-[var(--v2-ink-2)]">
          {hasActiveFilters
            ? 'Adjust or clear filters to widen the history.'
            : 'Send your first transaction to start building a history.'}
        </span>
        {!hasActiveFilters && (
          <Link
            href="/dashboard"
            className="text-xs font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)]"
          >
            Send your first transaction
          </Link>
        )}
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-[10px] border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-card)]">
      <div className="hidden border-b border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-3 md:block">
        <div className="grid grid-cols-[90px_minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1fr)_140px_130px_40px] gap-6 text-[11px] uppercase tracking-wide text-[var(--v2-ink-3)]">
          <span>Direction</span>
          <span>From</span>
          <span>To</span>
          <span>Initiator</span>
          <span className="text-right">Amount</span>
          <span>Timestamp</span>
          <span className="sr-only">Link</span>
        </div>
      </div>

      <div className="divide-y divide-[var(--v2-border)]">
        {transactions.map((tx, index) => (
          <div key={`${tx.safeId}:${tx.hash}:${tx.type}:${index}`}>
            <div className="hidden px-4 py-3 transition-colors hover:bg-[var(--v2-surface)] md:block">
              <div className="grid grid-cols-[90px_minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1fr)_140px_130px_40px] items-center gap-6">
                <div className="min-w-0">
                  <DirectionBadge direction={tx.direction} />
                </div>
                <AddressCell
                  address={tx.from}
                  resolveAddress={resolveAddress}
                  safeNamesByAddress={safeNamesByAddress}
                />
                <AddressCell
                  address={tx.to}
                  resolveAddress={resolveAddress}
                  safeNamesByAddress={safeNamesByAddress}
                />
                <div className="min-w-0">
                  {tx.direction === 'in' ? (
                    <span className="text-sm text-[var(--v2-ink-3)]">-</span>
                  ) : tx.agentName ? (
                    <span
                      className="inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--v2-border)] bg-[var(--v2-surface-2)] px-2 py-1 text-xs text-[var(--v2-ink-2)]"
                      title={`Agent: ${tx.agentName}`}
                    >
                      Agent: <span className="truncate">{tx.agentName}</span>
                    </span>
                  ) : (
                    <span className="text-sm text-[var(--v2-ink)]">User</span>
                  )}
                </div>
                <div className="text-right">
                  <div
                    className={`font-mono text-sm ${
                      tx.direction === 'in' ? 'text-[var(--v2-success)]' : 'text-[var(--v2-ink)]'
                    }`}
                  >
                    {tx.direction === 'in' ? '+' : '-'}
                    {tx.valueFormatted}
                  </div>
                  <div className="text-xs text-[var(--v2-ink-3)]">{tx.asset}</div>
                </div>
                <div
                  className="text-sm text-[var(--v2-ink-2)]"
                  title={new Date(tx.timestamp * 1000).toLocaleString()}
                >
                  {timeAgo(tx.timestamp * 1000)}
                </div>
                <a
                  href={getExplorerUrl(tx.chainId, 'tx', tx.hash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex justify-end text-[var(--v2-ink-3)] transition-colors hover:text-[var(--v2-ink)]"
                  title="Open in explorer"
                >
                  <ExternalLinkIcon />
                </a>
              </div>
            </div>

            <div className="space-y-3 p-4 md:hidden">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <DirectionBadge direction={tx.direction} />
                </div>
                <div className="text-right">
                  <div
                    className={`font-mono text-sm ${
                      tx.direction === 'in' ? 'text-[var(--v2-success)]' : 'text-[var(--v2-ink)]'
                    }`}
                  >
                    {tx.direction === 'in' ? '+' : '-'}
                    {tx.valueFormatted}
                  </div>
                  <div className="text-xs text-[var(--v2-ink-3)]">{tx.asset}</div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--v2-ink-3)]">
                    From
                  </div>
                  <AddressCell
                    address={tx.from}
                    resolveAddress={resolveAddress}
                    safeNamesByAddress={safeNamesByAddress}
                    compact
                  />
                </div>
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--v2-ink-3)]">
                    To
                  </div>
                  <AddressCell
                    address={tx.to}
                    resolveAddress={resolveAddress}
                    safeNamesByAddress={safeNamesByAddress}
                    compact
                  />
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  {tx.direction === 'in' ? (
                    <span className="text-xs text-[var(--v2-ink-3)]">-</span>
                  ) : tx.agentName ? (
                    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--v2-border)] bg-[var(--v2-surface-2)] px-2 py-1 text-xs text-[var(--v2-ink-2)]">
                      Agent: <span className="truncate">{tx.agentName}</span>
                    </span>
                  ) : (
                    <span className="text-xs text-[var(--v2-ink)]">User</span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className="text-xs text-[var(--v2-ink-2)]"
                    title={new Date(tx.timestamp * 1000).toLocaleString()}
                  >
                    {timeAgo(tx.timestamp * 1000)}
                  </span>
                  <a
                    href={getExplorerUrl(tx.chainId, 'tx', tx.hash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)]"
                    title="Open in explorer"
                  >
                    <ExternalLinkIcon />
                  </a>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function DirectionBadge({ direction }: { direction: 'in' | 'out' }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium ${
        direction === 'in'
          ? 'bg-[var(--v2-success-soft)] text-[var(--v2-success)]'
          : 'bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]'
      }`}
    >
      <span>{direction === 'in' ? '↓' : '↑'}</span>
      <span>{direction === 'in' ? 'In' : 'Out'}</span>
    </span>
  )
}

function AddressCell({
  address,
  resolveAddress,
  safeNamesByAddress,
  compact = false,
}: {
  address: string
  resolveAddress?: (address: string) => string | null
  safeNamesByAddress?: Map<string, string>
  compact?: boolean
}) {
  const safeName = safeNamesByAddress?.get(address.toLowerCase())
  const contactName = resolveAddress?.(address)
  const label = safeName ?? contactName ?? truncate(address)

  return (
    <div className="min-w-0">
      <div
        className={`truncate ${compact ? 'text-xs' : 'text-sm'} ${
          safeName ? 'text-[var(--v2-ink)]' : contactName ? 'text-[var(--v2-ink)]' : 'font-mono text-[var(--v2-ink-2)]'
        }`}
        title={address}
      >
        {label}
      </div>
    </div>
  )
}

function ExternalLinkIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
      />
    </svg>
  )
}
