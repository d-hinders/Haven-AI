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

/**
 * The authenticated chrome. Split out of `(authenticated)/layout.tsx` by #2521
 * so that layout can be a SERVER component and emit the `haven:auth` marker in
 * the rendered HTML; a client component cannot export `metadata`. Nothing about
 * the chrome or the client-side redirect changed in that move.
 */
export default function AuthenticatedShell({
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
            className="sr-only focus:not-sr-only focus:fixed focus:top-[max(1rem,var(--v2-safe-top))] focus:left-[max(1rem,var(--v2-safe-left))] focus:z-[var(--v2-z-toast)] focus:rounded-md focus:bg-[var(--v2-ink)] focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white focus:shadow-popover focus:outline-none focus:ring-2 focus:ring-white/80"
          >
            Skip to main content
          </a>
          {/*
            `overscroll-none` on the FIXED frame, never on the scroll region
            (#2730). In an installed standalone context a rubber-band drag on
            the frame peels the whole app off the top of the screen and shows
            the page background behind it — there is no browser chrome left for
            it to read as. This element is the frame: `h-screen overflow-hidden`,
            so it never scrolls and has nothing to lose by refusing the bounce.
            `<main>` below deliberately does NOT get it: `overscroll-behavior`
            there would take momentum scrolling with it, which is the one thing
            a phone must keep.
          */}
          <div
            data-app-frame=""
            className="flex h-screen overscroll-none bg-[var(--v2-bg)] text-[var(--v2-ink)] overflow-hidden"
          >
            <Sidebar />
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
              <TopBar />
              {/*
                  The scroll region's own insets (#2730), below `lg` only. The
                  bottom one is the load-bearing one: this box runs to the
                  bottom of the screen, so its last row — the last table row,
                  the last card's action — sits under the home indicator
                  without it. `calc` on the bottom because the 24px of `p-6` is
                  padding the CONTENT wants and the inset is clearance the
                  device demands, so they add; `max` on the sides because there
                  both are the same gutter measured two ways and the larger
                  wins.
              */}
              <main
                id="main-content"
                tabIndex={-1}
                className="flex-1 bg-[var(--v2-bg)] p-6 lg:p-8 max-lg:pb-[calc(1.5rem+var(--v2-safe-bottom))] max-lg:pl-[max(1.5rem,var(--v2-safe-left))] max-lg:pr-[max(1.5rem,var(--v2-safe-right))] overflow-y-auto focus:outline-none"
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
