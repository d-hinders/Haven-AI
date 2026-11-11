'use client'

import dynamic from 'next/dynamic'
import { BackLink } from '@haven_ai/ui/BackLink'
import { RouteLoading } from '@/components/ui/RouteLoading'

const AccountDetailClient = dynamic(() => import('./AccountDetailClient'), {
  ssr: false,
  // The way back exists while the page's own code is still loading, too (#4028).
  loading: () => (
    <div className="max-w-5xl">
      <BackLink href="/accounts" label="Accounts" />
      <RouteLoading className="p-8" />
    </div>
  ),
})

export default function AccountDetailPage() {
  return <AccountDetailClient />
}
