'use client'

import dynamic from 'next/dynamic'
import { PageHeader } from '@/components/ui/PageHeader'

const ApprovalQueue = dynamic(() => import('@/components/ApprovalQueue'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center gap-3 p-8">
      <div className="w-2 h-2 rounded-full bg-[var(--v2-brand)] animate-pulse" />
      <span className="text-sm text-[var(--v2-ink-3)]">Loading approvals...</span>
    </div>
  ),
})

export default function ApprovalsPage() {
  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Approvals"
        subtitle="Review agent payments that need your approval before any money moves."
      />

      <ApprovalQueue />
    </div>
  )
}
