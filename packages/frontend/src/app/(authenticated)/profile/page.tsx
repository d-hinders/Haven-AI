'use client'

import { Card } from '@/components/ui/Card'
import dynamic from 'next/dynamic'
import { Skeleton } from '@/components/ui/Skeleton'

const ProfileClient = dynamic(() => import('./ProfileClient'), {
  ssr: false,
  loading: () => (
    <div
      className="max-w-3xl space-y-6"
      role="status"
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading profile"
    >
      <div className="space-y-2">
        <Skeleton variant="text" className="h-8 w-32" />
        <Skeleton variant="text" className="h-5 w-full max-w-md" />
      </div>
      <div className="rounded-[10px] border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-card)]">
        <Card.Header padding="spacious" className="space-y-2">
          <Skeleton variant="text" className="h-5 w-40" />
          <Skeleton variant="text" className="h-4 w-full max-w-sm" />
        </Card.Header>
        <div className="space-y-4 px-6 py-5">
          <Skeleton variant="text" className="h-4 w-16" />
          <Skeleton variant="text" className="h-5 w-48" />
        </div>
        <div className="border-t border-[var(--v2-border)] px-6 py-4">
          <Skeleton variant="text" className="h-4 w-14" />
          <Skeleton variant="text" className="mt-2 h-5 w-56" />
        </div>
      </div>
    </div>
  ),
})

export default function ProfilePage() {
  return <ProfileClient />
}
