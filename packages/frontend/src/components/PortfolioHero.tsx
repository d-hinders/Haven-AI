'use client'

interface PortfolioHeroProps {
  totalFiat: number
  currency: 'USD' | 'EUR'
  safeName?: string
  loading: boolean
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
  safeName,
  loading,
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

          {/* Active Safe name pill */}
          {safeName && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-white/[0.03] border border-white/[0.06]">
              <svg className="w-3.5 h-3.5 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" />
              </svg>
              <span className="text-xs text-zinc-400">
                {safeName}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
