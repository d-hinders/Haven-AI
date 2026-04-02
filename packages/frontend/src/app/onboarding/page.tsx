'use client'

import dynamic from 'next/dynamic'

const OnboardingClient = dynamic(() => import('./OnboardingClient'), {
  ssr: false,
  loading: () => (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
      <div className="flex items-center gap-3">
        <div className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
        <span className="text-sm text-zinc-500">Loading...</span>
      </div>
    </div>
  ),
})

export default function OnboardingPage() {
  return <OnboardingClient />
}
