'use client'

import type { Transaction } from '@/types/transactions'
import { getExplorerUrl } from '@/lib/chains'
import { truncate, timeAgo as relativeTime } from '@/lib/format'

// Transactions store timestamps as unix seconds; convert to ms for timeAgo.
function timeAgo(timestamp: number): string {
  return relativeTime(timestamp * 1000)
}

const TYPE_LABELS: Record<string, string> = {
  native: 'Native',
  erc20: 'Token',
  internal: 'Internal',
}

interface TransactionListProps {
  transactions: Transaction[]
  loading: boolean
  error: string | null
  page: number
  pages: number
  total: number
  onPageChange: (page: number) => void
  onRefresh: () => void
  resolveAddress?: (address: string) => string | null
  /** Map of delegate address (lowercase) → agent name, for tx attribution */
  agentsByDelegate?: Map<string, string>
  chainId?: number
}

export default function TransactionList({
  transactions,
  loading,
  error,
  page,
  pages,
  total,
  onPageChange,
  onRefresh,
  resolveAddress,
  agentsByDelegate,
  chainId = 100,
}: TransactionListProps) {
  // Loading skeleton
  if (loading && transactions.length === 0) {
    return (
      <div className="space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="flex items-center gap-3 p-3 rounded-md bg-[var(--v2-surface)]"
          >
            <div className="w-7 h-7 rounded-full bg-[var(--v2-surface-2)] animate-pulse" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-32 bg-[var(--v2-surface-2)] rounded animate-pulse" />
              <div className="h-2 w-20 bg-[var(--v2-surface-2)] rounded animate-pulse" />
            </div>
            <div className="h-4 w-16 bg-[var(--v2-surface-2)] rounded animate-pulse" />
          </div>
        ))}
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-32 rounded-md border border-dashed border-red-400/20">
        <span className="text-sm text-red-400 mb-2">{error}</span>
        <button
          onClick={onRefresh}
          className="text-xs text-red-400 hover:text-red-300 underline underline-offset-2"
        >
          Retry
        </button>
      </div>
    )
  }

  // Empty state
  if (transactions.length === 0 && !loading) {
    return (
      <div className="flex flex-col items-center justify-center h-32 rounded-md border border-dashed border-[var(--v2-border)]">
        <span className="text-sm text-[var(--v2-ink-3)] mb-1">
          No transactions yet
        </span>
        <span className="text-xs text-[var(--v2-ink-3)]">
          Fund your Haven account to get started
        </span>
      </div>
    )
  }

  return (
    <div>
      {/* Header with count and refresh */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-[var(--v2-ink-3)]">
          {total} transaction{total !== 1 ? 's' : ''}
        </span>
        <button
          onClick={onRefresh}
          className="text-xs text-[var(--v2-ink-3)] hover:text-[var(--v2-ink-2)] transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Transaction rows */}
      <div className="space-y-1">
        {transactions.map((tx, i) => (
          <a
            key={`${tx.hash}-${tx.type}-${i}`}
            href={getExplorerUrl(chainId, 'tx', tx.hash)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 p-3 rounded-md hover:bg-[var(--v2-surface)] transition-colors group"
          >
            {/* Direction icon */}
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                tx.direction === 'in'
                  ? 'bg-emerald-500/10 text-emerald-400'
                  : 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-2)]'
              }`}
            >
              {tx.direction === 'in' ? '↓' : '↑'}
            </div>

            {/* Details */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm text-[var(--v2-ink)] truncate">
                  {tx.direction === 'in' ? 'From' : 'To'}{' '}
                  {(() => {
                    const addr = tx.direction === 'in' ? tx.from : tx.to
                    const name = resolveAddress?.(addr)
                    return name ? (
                      <span className="text-[var(--v2-ink)]" title={addr}>{name}</span>
                    ) : (
                      <span className="font-mono text-[var(--v2-ink-2)]">{truncate(addr)}</span>
                    )
                  })()}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-[var(--v2-surface-2)] text-[var(--v2-ink-3)] flex-shrink-0">
                  {TYPE_LABELS[tx.type] ?? tx.type}
                </span>
                {(() => {
                  const agentName = tx.agentName ?? agentsByDelegate?.get(tx.from.toLowerCase())
                  return agentName ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-indigo-500/10 text-indigo-400 flex-shrink-0 inline-flex items-center gap-1" title={`Agent: ${agentName}`}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
                        <path d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
                      </svg>
                      {agentName}
                    </span>
                  ) : null
                })()}
                {tx.isError && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-red-500/10 text-red-400 flex-shrink-0">
                    Failed
                  </span>
                )}
              </div>
              <span className="text-xs text-[var(--v2-ink-3)]">
                {timeAgo(tx.timestamp)}
              </span>
            </div>

            {/* Amount */}
            <div className="text-right flex-shrink-0">
              <span
                className={`text-sm font-medium ${
                  tx.direction === 'in' ? 'text-emerald-400' : 'text-[var(--v2-ink)]'
                }`}
              >
                {tx.direction === 'in' ? '+' : '-'}
                {tx.valueFormatted}
              </span>
              <span className="block text-xs text-[var(--v2-ink-3)]">{tx.asset}</span>
            </div>
          </a>
        ))}
      </div>

      {/* Pagination */}
      {pages > 1 && (
        <div className="flex items-center justify-between mt-4 pt-3 border-t border-[var(--v2-border)]">
          <button
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            className="text-xs text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            ← Newer
          </button>
          <span className="text-xs text-[var(--v2-ink-3)]">
            Page {page} of {pages}
          </span>
          <button
            onClick={() => onPageChange(page + 1)}
            disabled={page >= pages}
            className="text-xs text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Older →
          </button>
        </div>
      )}
    </div>
  )
}
