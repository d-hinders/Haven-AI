'use client'

import { Card } from '@/components/ui/Card'
import dynamic from 'next/dynamic'
import { Skeleton } from '@/components/ui/Skeleton'

const SettingsClient = dynamic(() => import('./SettingsClient'), {
  ssr: false,
  loading: () => (
    <div
      className="max-w-6xl space-y-6"
      role="status"
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading settings"
    >
      <div className="space-y-2">
        <Skeleton variant="text" className="h-8 w-36" />
        <Skeleton variant="text" className="h-5 w-full max-w-xl" />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Skeleton className="h-32 rounded-[10px]" />
        <Skeleton className="h-32 rounded-[10px]" />
        <Skeleton className="h-32 rounded-[10px]" />
      </div>
      <div className="rounded-[10px] border border-[var(--v2-border)] bg-white shadow-card">
        <Card.Header padding="spacious" className="space-y-2">
          <Skeleton variant="text" className="h-4 w-32" />
          <Skeleton variant="text" className="h-4 w-full max-w-sm" />
        </Card.Header>
        <div className="space-y-4 px-6 py-5">
          <Skeleton variant="text" className="h-5 w-full max-w-md" />
          <Skeleton variant="text" className="h-5 w-full max-w-lg" />
        </div>
      </div>
      <span className="sr-only">Loading settings</span>
    </div>
  ),
})

export default function SettingsPage() {
  return <SettingsClient />
}
