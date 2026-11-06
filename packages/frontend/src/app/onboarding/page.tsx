'use client'

import dynamic from 'next/dynamic'
import { RouteLoading } from '@/components/ui/RouteLoading'

const OnboardingClient = dynamic(() => import('./OnboardingClient'), {
  ssr: false,
  loading: () => (
    <div className="min-h-screen bg-[var(--v2-bg)] flex items-center justify-center">
      <RouteLoading />
    </div>
  ),
})

export default function OnboardingPage() {
  return <OnboardingClient />
}
