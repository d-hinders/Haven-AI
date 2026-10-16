'use client'

import dynamic from 'next/dynamic'
import { BackLink } from '@haven_ai/ui/BackLink'

const AccountDetailClient = dynamic(() => import('./AccountDetailClient'), {
  ssr: false,
  // The way back exists while the page's own code is still loading, too (#4028).
  loading: () => (
    <div className="max-w-5xl">
      <BackLink href="/accounts" label="Accounts" />
      <div className="flex items-center gap-3 p-8">
        <div className="w-2 h-2 rounded-full bg-[var(--v2-brand)] animate-pulse" />
        <span className="text-sm text-[var(--v2-ink-3)]">Loading...</span>
      </div>
    </div>
  ),
})

export default function AccountDetailPage() {
  return <AccountDetailClient />
}
