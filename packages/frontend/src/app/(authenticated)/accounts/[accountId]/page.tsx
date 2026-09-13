'use client'

import dynamic from 'next/dynamic'

const AccountDetailClient = dynamic(() => import('./AccountDetailClient'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center gap-3 p-8">
      <div className="w-2 h-2 rounded-full bg-[var(--v2-brand)] animate-pulse" />
      <span className="text-sm text-[var(--v2-ink-3)]">Loading...</span>
    </div>
  ),
})

export default function AccountDetailPage() {
  return <AccountDetailClient />
}
