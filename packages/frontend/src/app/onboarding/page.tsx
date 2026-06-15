'use client'

import dynamic from 'next/dynamic'

const OnboardingClient = dynamic(() => import('./OnboardingClient'), {
  ssr: false,
  loading: () => (
    <div className="min-h-screen bg-[var(--v2-bg)] flex items-center justify-center">
      <div className="flex items-center gap-3">
        <div className="w-2 h-2 rounded-full bg-[var(--v2-brand)] animate-pulse" />
        <span className="text-sm text-[var(--v2-ink-3)]">Loading...</span>
      </div>
    </div>
  ),
})

export default function OnboardingPage() {
  return <OnboardingClient />
}
