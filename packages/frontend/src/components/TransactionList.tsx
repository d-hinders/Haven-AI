'use client'

import type { Transaction } from '@/types/transactions'

function truncate(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor(Date.now() / 1000 - timestamp)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`
  return new Date(timestamp * 1000).toLocaleDateString()
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
}: TransactionListProps) {
  // Loading skeleton
  if (loading && transactions.length === 0) {
    return (
      <div className="space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="flex items-center gap-3 p-3 rounded-md bg-white/[0.02]"
          >
            <div className="w-7 h-7 rounded-full bg-white/[0.06] animate-pulse" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-32 bg-white/[0.06] rounded animate-pulse" />
              <div className="h-2 w-20 bg-white/[0.06] rounded animate-pulse" />
            </div>
            <div className="h-4 w-16 bg-white/[0.06] rounded animate-pulse" />
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
      <div className="flex flex-col items-center justify-center h-32 rounded-md border border-dashed border-white/[0.06]">
        <span className="text-sm text-zinc-600 mb-1">
          No transactions yet
        </span>
        <span className="text-xs text-zinc-700">
          Fund your Safe to get started
        </span>
      </div>
    )
  }

  return (
    <div>
      {/* Header with count and refresh */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-zinc-600">
          {total} transaction{total !== 1 ? 's' : ''}
        </span>
        <button
          onClick={onRefresh}
          className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Transaction rows */}
      <div className="space-y-1">
        {transactions.map((tx, i) => (
          <a
            key={`${tx.hash}-${tx.type}-${i}`}
            href={`https://gnosisscan.io/tx/${tx.hash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 p-3 rounded-md hover:bg-white/[0.03] transition-colors group"
          >
            {/* Direction icon */}
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                tx.direction === 'in'
                  ? 'bg-emerald-500/10 text-emerald-400'
                  : 'bg-zinc-500/10 text-zinc-400'
              }`}
            >
              {tx.direction === 'in' ? '↓' : '↑'}
            </div>

            {/* Details */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm text-[#ededed] truncate">
                  {tx.direction === 'in' ? 'From' : 'To'}{' '}
                  {(() => {
                    const addr = tx.direction === 'in' ? tx.from : tx.to
                    const name = resolveAddress?.(addr)
                    return name ? (
                      <span className="text-zinc-300" title={addr}>{name}</span>
                    ) : (
                      <span className="font-mono text-zinc-400">{truncate(addr)}</span>
                    )
                  })()}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-white/[0.04] text-zinc-600 flex-shrink-0">
                  {TYPE_LABELS[tx.type] ?? tx.type}
                </span>
                {tx.isError && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-red-500/10 text-red-400 flex-shrink-0">
                    Failed
                  </span>
                )}
              </div>
              <span className="text-xs text-zinc-600">
                {timeAgo(tx.timestamp)}
              </span>
            </div>

            {/* Amount */}
            <div className="text-right flex-shrink-0">
              <span
                className={`text-sm font-medium ${
                  tx.direction === 'in' ? 'text-emerald-400' : 'text-[#ededed]'
                }`}
              >
                {tx.direction === 'in' ? '+' : '-'}
                {tx.valueFormatted}
              </span>
              <span className="block text-xs text-zinc-600">{tx.asset}</span>
            </div>
          </a>
        ))}
      </div>

      {/* Pagination */}
      {pages > 1 && (
        <div className="flex items-center justify-between mt-4 pt-3 border-t border-white/[0.06]">
          <button
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            ← Newer
          </button>
          <span className="text-xs text-zinc-600">
            Page {page} of {pages}
          </span>
          <button
            onClick={() => onPageChange(page + 1)}
            disabled={page >= pages}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Older →
          </button>
        </div>
      )}
    </div>
  )
}
