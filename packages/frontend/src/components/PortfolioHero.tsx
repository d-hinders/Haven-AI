'use client'

interface PortfolioHeroProps {
  totalFiat: number
  currency: 'USD' | 'EUR'
  loading: boolean
  onSend: () => void
  onReceive: () => void
  onAddFunds: () => void
  sendDisabled?: boolean
  receiveDisabled?: boolean
  actionsHint?: string
}

function formatCurrency(value: number, currency: 'USD' | 'EUR'): string {
  return new Intl.NumberFormat(currency === 'EUR' ? 'de-DE' : 'en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

export default function PortfolioHero({
  totalFiat,
  currency,
  loading,
  onSend,
  onReceive,
  onAddFunds,
  sendDisabled = false,
  receiveDisabled = false,
  actionsHint,
}: PortfolioHeroProps) {
  return (
    <div className="relative rounded-xl border border-white/[0.06] overflow-hidden mb-8">
      {/* Gradient background */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'linear-gradient(135deg, rgba(99,102,241,0.06) 0%, rgba(139,92,246,0.04) 50%, rgba(99,102,241,0.02) 100%)',
        }}
      />

      <div className="relative p-8">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <p className="text-xs text-zinc-500 mb-2 uppercase tracking-widest">
              Total balance
            </p>
            {loading ? (
              <div className="h-10 w-48 bg-white/[0.06] rounded animate-pulse" />
            ) : (
              <p className="text-4xl font-bold tracking-tight bg-gradient-to-r from-white via-white to-indigo-200 bg-clip-text text-transparent">
                {formatCurrency(totalFiat, currency)}
              </p>
            )}
          </div>

          <div className="flex flex-col items-stretch sm:items-end gap-2.5">
            <div className="flex flex-wrap sm:justify-end gap-2">
              <button
                type="button"
                onClick={onSend}
                disabled={sendDisabled}
                className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-[var(--v2-brand)] text-white text-sm font-medium hover:bg-[var(--v2-brand-strong)] transition-colors shadow-[var(--v2-shadow-button)] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-[var(--v2-brand)] disabled:shadow-none"
              >
                Send
              </button>
              <button
                type="button"
                onClick={onReceive}
                disabled={receiveDisabled}
                className="inline-flex items-center justify-center px-4 py-2 rounded-lg border border-white/[0.10] bg-white/[0.03] text-zinc-200 text-sm font-medium hover:bg-white/[0.06] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Receive
              </button>
              <button
                type="button"
                onClick={onAddFunds}
                className="inline-flex items-center justify-center px-4 py-2 rounded-lg border border-white/[0.08] bg-white/[0.02] text-zinc-300 text-sm font-medium hover:bg-white/[0.05] hover:text-zinc-200 transition-colors"
              >
                Add funds
              </button>
            </div>
            {actionsHint && (
              <p className="text-[11px] text-zinc-500 sm:text-right max-w-xs">
                {actionsHint}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
