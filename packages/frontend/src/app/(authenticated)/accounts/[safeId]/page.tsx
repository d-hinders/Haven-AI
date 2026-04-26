'use client'

import dynamic from 'next/dynamic'

const AccountDetailClient = dynamic(() => import('./AccountDetailClient'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center gap-3 p-8">
      <div className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
      <span className="text-sm text-zinc-500">Loading...</span>
    </div>
  ),
})

export default function AccountDetailPage() {
  return <AccountDetailClient />
}
