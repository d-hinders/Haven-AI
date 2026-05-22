'use client'

import dynamic from 'next/dynamic'
import { PageHeader } from '@/components/ui/PageHeader'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'

const ApprovalQueue = dynamic(() => import('@/components/ApprovalQueue'), {
  ssr: false,
  loading: () => (
    <div role="status" aria-busy="true" aria-live="polite" aria-label="Loading approvals" className="space-y-3">
      <Card hover={false} className="p-5">
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-28 rounded-full" />
          <Skeleton variant="text" className="h-3 w-20" />
        </div>
        <Skeleton className="mt-5 h-8 w-44" />
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-16 rounded-[10px] bg-[var(--v2-surface)]" />
          <Skeleton className="h-16 rounded-[10px] bg-[var(--v2-surface)]" />
        </div>
      </Card>
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
