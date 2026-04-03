'use client'

import type { BalanceItem } from '@/types/transactions'

const TOKEN_COLORS: Record<string, string> = {
  xDAI: 'from-emerald-400 to-teal-500',
  EURe: 'from-blue-400 to-cyan-500',
  'USDC.e': 'from-indigo-400 to-violet-500',
}

interface BalanceCardsProps {
  balances: BalanceItem[]
  loading: boolean
  error: string | null
  onRefresh: () => void
}

export default function BalanceCards({
  balances,
  loading,
  error,
  onRefresh,
}: BalanceCardsProps) {
  if (loading && balances.length === 0) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-white/[0.06] rounded-lg overflow-hidden mb-10">
        {[0, 1, 2].map((i) => (
          <div key={i} className="bg-[#0a0a0a] p-6">
            <div className="h-3 w-12 bg-white/[0.06] rounded animate-pulse mb-3" />
            <div className="h-7 w-24 bg-white/[0.06] rounded animate-pulse" />
          </div>
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-400/20 bg-red-400/5 p-4 mb-10 flex items-center justify-between">
        <span className="text-sm text-red-400">{error}</span>
        <button
          onClick={onRefresh}
          className="text-xs text-red-400 hover:text-red-300 underline underline-offset-2"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-white/[0.06] rounded-lg overflow-hidden mb-10">
      {balances.map((b) => {
        const gradient = TOKEN_COLORS[b.symbol] ?? 'from-zinc-400 to-zinc-500'
        return (
          <div key={b.symbol} className="bg-[#0a0a0a] p-6 group">
            <div className="flex items-center gap-2 mb-3">
              <div
                className={`w-2 h-2 rounded-full bg-gradient-to-br ${gradient}`}
              />
              <span className="text-xs text-zinc-500">{b.symbol}</span>
            </div>
            <span className="text-xl font-semibold tracking-tight">
              {b.formatted}
            </span>
          </div>
        )
      })}
    </div>
  )
}
