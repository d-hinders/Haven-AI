'use client'

import dynamic from 'next/dynamic'
import ProtectedRoute from '@/components/ProtectedRoute'
import ErrorBoundary from '@/components/ErrorBoundary'
import TopBar from '@/components/TopBar'
import { OwnerDirectoryProvider } from '@/context/OwnerDirectoryContext'
import { ToastProvider, Toaster } from '@/components/ui/Toast'

const Sidebar = dynamic(() => import('@/components/sidebar/Sidebar'), {
  ssr: false,
})

export default function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <ProtectedRoute>
      <OwnerDirectoryProvider>
        <ToastProvider>
          {/*
            Two deliberate departures from the one focus-ring treatment (#1746),
            both because this control is unlike every other one:

            1. `focus:`, not `focus-visible:`. The link is `sr-only` until
               focused, so it is only ever reachable by keyboard — the two
               selectors coincide here — and splitting the ring onto a different
               selector from the dozen `focus:` layout utilities that reveal the
               pill would leave one element with two focus states.
            2. A WHITE ring, not brand. The ring sits on the `--v2-ink` pill, and
               brand indigo on that fill measures 2.10:1 at /80 and only 2.58:1
               at full opacity — it can never reach 3:1 on a dark surface (#1741).
               White reaches 10.76:1. Same rule as CodeBlock on `--v2-surface-code`.

            The real focus indicator here is the pill appearing at all (16.24:1
            against the page); the ring is reinforcement on top of that.
          */}
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[var(--v2-z-toast)] focus:rounded-md focus:bg-[var(--v2-ink)] focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white focus:shadow-popover focus:outline-none focus:ring-2 focus:ring-white/80"
          >
            Skip to main content
          </a>
          <div className="flex h-screen bg-[var(--v2-bg)] text-[var(--v2-ink)] overflow-hidden">
            <Sidebar />
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
              <TopBar />
              <main
                id="main-content"
                tabIndex={-1}
                className="flex-1 bg-[var(--v2-bg)] p-6 lg:p-8 overflow-y-auto focus:outline-none"
              >
                <ErrorBoundary>{children}</ErrorBoundary>
              </main>
            </div>
          </div>
          <Toaster />
        </ToastProvider>
      </OwnerDirectoryProvider>
    </ProtectedRoute>
  )
}
