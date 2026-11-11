'use client'

import dynamic from 'next/dynamic'
import { RouteLoading } from '@/components/ui/RouteLoading'

// The same lazy, client-only mount as `transactions` and `dashboard`: the page
// reads an aggregate over the reader's history, so it is meaningful only with
// the session, the Settings currency and `localStorage` in hand (#2947).
const AnalyticsClient = dynamic(() => import('./AnalyticsClient'), {
  ssr: false,
  loading: () => <RouteLoading className="p-8" />,
})

export default function AnalyticsPage() {
  return <AnalyticsClient />
}
