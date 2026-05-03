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
  showSafeTag: boolean
  hasActiveFilters: boolean
}

export default function TransactionsTable({
  transactions,
  loading,
  error,
  onRefresh,
  resolveAddress,
  safeNamesByAddress,
  showSafeTag,
  hasActiveFilters,
}: TransactionsTableProps) {
  if (loading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="flex items-center gap-3 rounded-md bg-white/[0.02] p-3"
          >
            <div className="h-7 w-7 rounded-full bg-white/[0.06] animate-pulse" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-40 rounded bg-white/[0.06] animate-pulse" />
              <div className="h-2 w-28 rounded bg-white/[0.06] animate-pulse" />
            </div>
            <div className="h-4 w-16 rounded bg-white/[0.06] animate-pulse" />
          </div>
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-32 flex-col items-center justify-center rounded-md border border-dashed border-red-400/20">
        <span className="mb-2 text-sm text-red-400">{error}</span>
        <button
          onClick={onRefresh}
          className="text-xs text-red-400 underline underline-offset-2 hover:text-red-300"
        >
          Retry
        </button>
      </div>
    )
  }

  if (transactions.length === 0) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center rounded-md border border-dashed border-white/[0.06] px-6 text-center">
        <span className="mb-1 text-sm text-zinc-500">
          {hasActiveFilters ? 'No transactions match these filters' : 'No transactions yet'}
        </span>
        <span className="mb-4 text-xs text-zinc-700">
          {hasActiveFilters
            ? 'Adjust or clear filters to widen the history.'
            : 'Send your first transaction to start building a history.'}
        </span>
        {!hasActiveFilters && (
          <Link
            href="/dashboard"
            className="text-xs text-indigo-400 hover:text-indigo-300"
          >
            Send your first transaction
          </Link>
        )}
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.01]">
      <div className="hidden border-b border-white/[0.06] px-4 py-3 md:block">
        <div className="grid grid-cols-[90px_minmax(0,1.25fr)_minmax(0,1.25fr)_minmax(0,1fr)_120px_110px_40px] gap-4 text-[11px] uppercase tracking-wide text-zinc-600">
          <span>Direction</span>
          <span>From</span>
          <span>To</span>
          <span>Initiator</span>
          <span className="text-right">Amount</span>
          <span>Timestamp</span>
          <span className="sr-only">Link</span>
        </div>
      </div>

      <div className="divide-y divide-white/[0.04]">
        {transactions.map((tx, index) => (
          <div key={`${tx.safeId}:${tx.hash}:${tx.type}:${index}`}>
            <div className="hidden px-4 py-3 transition-colors hover:bg-white/[0.03] md:block">
              <div className="grid grid-cols-[90px_minmax(0,1.25fr)_minmax(0,1.25fr)_minmax(0,1fr)_120px_110px_40px] items-center gap-4">
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
                    <span className="text-sm text-zinc-600">-</span>
                  ) : tx.agentName ? (
                    <span
                      className="inline-flex max-w-full items-center gap-1 rounded-full bg-indigo-500/10 px-2 py-1 text-xs text-indigo-400"
                      title={`Agent: ${tx.agentName}`}
                    >
                      Agent: <span className="truncate">{tx.agentName}</span>
                    </span>
                  ) : (
                    <span className="text-sm text-zinc-300">User</span>
                  )}
                </div>
                <div className="text-right">
                  <div
                    className={`font-mono text-sm ${
                      tx.direction === 'in' ? 'text-emerald-400' : 'text-[#ededed]'
                    }`}
                  >
                    {tx.direction === 'in' ? '+' : '-'}
                    {tx.valueFormatted}
                  </div>
                  <div className="text-xs text-zinc-500">{tx.asset}</div>
                </div>
                <div
                  className="text-sm text-zinc-500"
                  title={new Date(tx.timestamp * 1000).toLocaleString()}
                >
                  {timeAgo(tx.timestamp * 1000)}
                </div>
                <a
                  href={getExplorerUrl(tx.chainId, 'tx', tx.hash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex justify-end text-zinc-500 transition-colors hover:text-zinc-300"
                  title="Open in explorer"
                >
                  <ExternalLinkIcon />
                </a>
              </div>

              {showSafeTag && (
                <div className="mt-2">
                  <span className="rounded-sm bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-zinc-500">
                    From Safe: {tx.safeName}
                  </span>
                </div>
              )}
            </div>

            <div className="space-y-3 p-4 md:hidden">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <DirectionBadge direction={tx.direction} />
                  {showSafeTag && (
                    <div className="mt-2">
                      <span className="rounded-sm bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-zinc-500">
                        {tx.safeName}
                      </span>
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <div
                    className={`font-mono text-sm ${
                      tx.direction === 'in' ? 'text-emerald-400' : 'text-[#ededed]'
                    }`}
                  >
                    {tx.direction === 'in' ? '+' : '-'}
                    {tx.valueFormatted}
                  </div>
                  <div className="text-xs text-zinc-500">{tx.asset}</div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-600">
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
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-600">
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
                    <span className="text-xs text-zinc-600">-</span>
                  ) : tx.agentName ? (
                    <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-indigo-500/10 px-2 py-1 text-xs text-indigo-400">
                      Agent: <span className="truncate">{tx.agentName}</span>
                    </span>
                  ) : (
                    <span className="text-xs text-zinc-300">User</span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className="text-xs text-zinc-500"
                    title={new Date(tx.timestamp * 1000).toLocaleString()}
                  >
                    {timeAgo(tx.timestamp * 1000)}
                  </span>
                  <a
                    href={getExplorerUrl(tx.chainId, 'tx', tx.hash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-zinc-500 hover:text-zinc-300"
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
          ? 'bg-emerald-500/10 text-emerald-400'
          : 'bg-zinc-500/10 text-zinc-300'
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
          safeName ? 'text-zinc-200' : contactName ? 'text-zinc-300' : 'font-mono text-zinc-400'
        }`}
        title={address}
      >
        {label}
      </div>
      {safeName && (
        <div className="mt-1">
          <span className="rounded-sm bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-zinc-500">
            Safe
          </span>
        </div>
      )}
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
