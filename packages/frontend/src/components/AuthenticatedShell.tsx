'use client'

import dynamic from 'next/dynamic'
import ProtectedRoute from '@/components/ProtectedRoute'
import ErrorBoundary from '@/components/ErrorBoundary'
import { SafeAreaBand } from '@/components/ui/SafeAreaBand'
import { ToastProvider, Toaster } from '@/components/ui/Toast'
import { isProductionEnvironment } from '@/lib/env'

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
            className="sr-only focus:not-sr-only focus:fixed focus:top-[max(1rem,var(--v2-safe-top))] focus:left-[max(1rem,var(--v2-safe-left))] focus:z-[var(--v2-z-toast)] focus:rounded-md focus:bg-[var(--v2-ink)] focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-[var(--v2-bg)] focus:shadow-popover focus:outline-none focus:ring-2 focus:ring-bg/80"
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

            `relative` is load-bearing: the warning line at the bottom of this
            element is positioned against the frame, so a 2px strip can span
            the top of the app without becoming a flex child that pushes the
            layout down.

            `--v2-sticky-head`: `packages/ui`'s `Table` pins its `<thead>` with
            `-top-[var(--v2-sticky-head)]`, compensating for the scroll
            container's top padding. The token defaults to -1.5rem — the `py-6`
            the ops shell uses, unchanged — and the authenticated app overrides
            it here to match its own padding: 16px below `lg`, 32px at and
            above. One variable, both shells, no responsive class inside the
            shared primitive.
          */}
          <div
            data-app-frame=""
            className="relative flex h-screen overscroll-none bg-[var(--v2-bg)] text-[var(--v2-ink)] overflow-hidden max-lg:[--v2-sticky-head:-1rem] lg:[--v2-sticky-head:-2rem]"
          >
            <Sidebar />
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
              {/*
                The status-bar band, now rendered by the shell itself (#4029).
                `SafeAreaBand` was the top bar's first child while the bar
                existed; with the bar gone the band is the only chrome left
                above the scroll region, so the shell owns it directly — same
                element, same opaque `bg-bg` fill, same contract as the
                component's docstring (never inside a `backdrop-filter` layer).
              */}
              <SafeAreaBand />
              {/*
                  The scroll region's own insets (#2730), below `lg` only. The
                  bottom one is the load-bearing one: this box runs to the
                  bottom of the screen, so its last row — the last table row,
                  the last card's action — sits under the home indicator
                  without it.

                  #2731 adds the tab bar's height to the same `calc`, for the
                  same reason one layer up: the bar is `fixed` and consumes no
                  layout, so without this the last row sits under the BAR
                  instead of under the home indicator. Three terms, three
                  different owners — content padding, chrome height, device
                  inset — which is why they add rather than `max`. `calc` on the bottom because the 24px of `p-6` is
                  padding the CONTENT wants and the inset is clearance the
                  device demands, so they add; `max` on the sides because there
                  both are the same gutter measured two ways and the larger
                  wins.
              */}
              <main
                id="main-content"
                tabIndex={-1}
                className="flex-1 bg-[var(--v2-bg)] p-6 pt-4 lg:p-8 max-lg:pb-[calc(1.5rem+var(--v2-tab-bar-h)+var(--v2-safe-bottom))] max-lg:pl-[max(1.5rem,var(--v2-safe-left))] max-lg:pr-[max(1.5rem,var(--v2-safe-right))] overflow-y-auto focus:outline-none"
              >
                <ErrorBoundary>{children}</ErrorBoundary>
              </main>
            </div>
            {/*
              The non-production warning line (#4029). A 2px `--v2-warning` strip
              along the top of the app wherever this deploy is not production. It
              is the badge's visual echo, not its replacement: the badge in the
              sidebar's logo band carries the accessible label, and this line is
              `aria-hidden` and `pointer-events-none` — it must be seen, never
              reached.

              The LAST child of the frame, positioned, NOT in flow: the frame is
              a flex row (sidebar | column), and a 2px flex child would push the
              whole app down and paint the line over the safe-area band on a
              phone. `absolute` against the frame's own `relative` (above) keeps
              `h-screen` exact. The top offset is `var(--v2-safe-top)`, which is
              0 on desktop — where the line spans the top of the app — and the
              inset on a notched phone, where the line sits directly UNDER the
              opaque status-bar band rendered above.

              `z-[var(--v2-z-chrome)]`: the chrome tier. Above page content,
              below the More sheet, its scrim and modals. The tier used to belong
              to the top bar; its only remaining consumer is this line, and the
              ordering the scale encodes (navigation outranks chrome) still
              holds — the drawer must cover the line that says a deploy is not
              production.

              Deliberately no opacity modifier on the fill. An opacity-modified
              arbitrary var (`bg-[var(--v2-bg)]/85`) is the dead shape #1818
              compiled to nothing — `bg-[var(--v2-warning)]` at full opacity is a
              real colour, and anything translucent here would defeat the point
              of a warning you can see from across the room. It renders nothing
              in production, so production screenshots and CI baselines contain
              no line.
            */}
            {!isProductionEnvironment() && (
              <div
                aria-hidden="true"
                data-warning-line=""
                className="pointer-events-none absolute inset-x-0 top-[var(--v2-safe-top)] z-[var(--v2-z-chrome)] h-[2px] bg-[var(--v2-warning)]"
              />
            )}
          </div>
          <Toaster />
        </ToastProvider>
    </ProtectedRoute>
  )
}
