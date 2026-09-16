'use client'

import dynamic from 'next/dynamic'

// The same lazy, client-only mount as `transactions` and `dashboard`: the page
// reads an aggregate over the reader's history, so it is meaningful only with
// the session, the Settings currency and `localStorage` in hand (#2947).
const AnalyticsClient = dynamic(() => import('./AnalyticsClient'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center gap-3 p-8">
      <div className="w-2 h-2 rounded-full bg-[var(--v2-brand)] animate-pulse" />
      <span className="text-sm text-[var(--v2-ink-2)]">Loading...</span>
    </div>
  ),
})

export default function AnalyticsPage() {
  return <AnalyticsClient />
}
