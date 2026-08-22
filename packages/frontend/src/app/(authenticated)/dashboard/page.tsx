'use client'

import dynamic from 'next/dynamic'

const DashboardClient = dynamic(() => import('./DashboardClient'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center gap-3 p-8">
      <div className="w-2 h-2 rounded-full bg-[var(--v2-brand)] animate-pulse" />
      <span className="text-sm text-[var(--v2-ink-3)]">Loading...</span>
    </div>
  ),
})

export default function DashboardPage() {
  // ---------------------------------------------------------------------------
  // DELIBERATE MUTATION — #1768 acceptance proof. REVERTED IN THE NEXT COMMIT.
  //
  // A mobile-ONLY regression: `w-[120vw]` below the `sm` breakpoint (640px),
  // `w-auto` at and above it. At the desktop project's 1280px this is inert, so
  // every existing desktop spec — including `dashboard.spec.ts`, which loads
  // this exact route — must stay green. At the mobile project's 393px it
  // overflows the viewport horizontally.
  //
  // Scoped to `/dashboard` on purpose so the *Design visual regression* job
  // (which shoots `/design-system`) is untouched and cannot be confused for the
  // check that caught this.
  //
  // Expected: "Frontend browser smoke" RED on
  // `navigation.mobile.spec.ts › /dashboard fits the screen and renders clean`,
  // with every desktop test still passing. Before #1768 this regression would
  // have gone green on every pull request.
  // ---------------------------------------------------------------------------
  return (
    <div className="w-[120vw] sm:w-auto">
      <DashboardClient />
    </div>
  )
}
