'use client'

import type { RefObject } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Menu, X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import type { NavItem } from './Sidebar'

/**
 * The primary navigation below `lg` (#2731).
 *
 * ## "More" is the fifth cell (#4053)
 *
 * Until #4053 the More control was a DOM sibling of this bar, painted into
 * the fifth column from outside on the higher `--v2-z-nav-toggle` tier,
 * because #2820's full-screen drawer covered the bar and the same button had
 * to stay on top of it to close it again. The phone menu is now a bottom
 * sheet that stops at this bar's top edge — it never covers the bar — so the
 * control is an ordinary cell of the grid, on the bar's own tier, beside the
 * four tabs it belongs with. Its accessible name stays `Open sidebar` /
 * `Close sidebar`: the capture harness and the e2e fixtures match those
 * whole strings.
 *
 * ## Selection is by ROUTE, never by index
 *
 * `baseNavItems` is ordered for the rail (Dashboard, Analytics, Accounts,
 * Transactions, Accounting, Agents, Marketplace, Contacts — regrouped by #3024,
 * Analytics from #2947; Marketplace renamed from Catalog by #3079); the bar's order
 * is the issue's (Dashboard, Agents, Transactions, Accounts), unchanged by that
 * regroup. Reading it by position would silently reorder the bar the next
 * time someone inserts a rail entry, so the tabs are picked by `href` and the
 * lookup throws nothing — a route that disappears simply drops out, and the
 * count assertion in the e2e spec is what notices.
 */
export const TAB_ROUTES = ['/dashboard', '/agents', '/transactions', '/accounts'] as const

/**
 * Active for the hub AND its detail pages: `/agents/agent-research` lights
 * Agents. Prefix-matched on a `/` boundary so `/accounts` never lights for a
 * hypothetical `/accounts-archive`.
 */
export function isActiveRoute(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}

/**
 * `presentational` swaps the fixed viewport placement for in-flow layout so
 * `/design-system` can render THIS component rather than a hand-rolled copy of
 * it. The showcase's mirror of `TransactionsTable` drifted for exactly one
 * merge and needed #2792 to notice — the same trade is not worth taking twice.
 * It is the `WalletPopover` pattern already used on that page.
 */
export function MobileTabBar({
  items,
  presentational = false,
  activeHref,
  more,
}: {
  items: NavItem[]
  presentational?: boolean
  /** The live More cell. Absent on the `/design-system` illustration. */
  more?: {
    open: boolean
    onToggle: () => void
    /** Called on every tab tap — the SAME route included, where no route change would close the sheet. */
    onClose: () => void
    buttonRef: RefObject<HTMLButtonElement | null>
  }
  /**
   * Overrides the route for the illustration on `/design-system`, where
   * `usePathname()` matches no tab and every slot would render inactive — the
   * one state a design-system entry for a tab bar exists to teach.
   */
  activeHref?: string
}) {
  const livePath = usePathname() ?? ''
  const pathname = activeHref ?? livePath
  const tabs = TAB_ROUTES.map((href) => items.find((i) => i.href === href)).filter(
    (i): i is NavItem => i !== undefined,
  )

  return (
    <nav
      aria-label={presentational ? undefined : 'Primary'}
      // `inert`, not `aria-hidden` (#2731 review). `aria-hidden` on a container
      // of four focusable links is `aria-hidden-focus` / WCAG 4.1.2: a keyboard
      // user tabs into something the accessibility tree says is not there, and
      // is navigated off the showcase by an illustration. `inert` removes both
      // the focusability and the tree entry, which is what "this is a picture"
      // actually means.
      // `inert: true`, not `inert: ''` — the empty string is the React 18
      // workaround, and under React 19 (`^19.0.0` here) it makes React drop the
      // attribute entirely with a console warning, leaving the four `<Link>`s
      // focusable and in the a11y tree — the fifth slot is a non-interactive
      // `<span>`. The guard the comment above describes was inoperative until
      // #2819's capture surfaced the warning.
      {...(presentational ? { inert: true } : {})}
      data-mobile-tab-bar=""
      className={`grid grid-cols-5 border-t border-[var(--v2-border)] bg-[var(--v2-bg)] ${
        presentational
          ? 'relative w-full'
          : 'lg:hidden fixed bottom-0 inset-x-0 z-[var(--v2-z-tab-bar)] pb-[var(--v2-safe-bottom)] pl-[var(--v2-safe-left)] pr-[var(--v2-safe-right)]'
      }`}
    >
      {tabs.map((item) => {
        const active = isActiveRoute(pathname, item.href)
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={more?.onClose}
            aria-current={active ? 'page' : undefined}
            className={`relative flex h-[var(--v2-tab-bar-h)] flex-col items-center justify-center gap-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/80 ${
              active ? 'text-[var(--v2-brand)]' : 'text-[var(--v2-ink-3)]'
            }`}
          >
            {/* One "you are here" idiom across both halves of the same
                navigation (#2818). The drawer this bar opens is two feet away
                on one 390px screen and marks active — still, and unchanged
                by this commit — in brand ink on a `--v2-brand-soft` fill with
                a 2px brand rail down the left edge. The bar did not match it:
                it marked active in ink value alone. On `/agents` with the
                drawer open both idioms were visible at once.

                The bar is the side that moved, and it takes the drawer's idiom
                translated from a row to a cell: the rail runs across the TOP
                edge instead of the left, and the fill is dropped because a
                tinted 56px cell reads as a pressed button rather than as a
                selection.

                The rail is NOT decoration. Brand ink alone would be a WCAG
                1.4.1 regression: `--v2-brand` against `--v2-ink-3` is 1.18:1,
                a hue difference with no luminance difference, so the active
                tab would be indistinguishable in greyscale and to a
                colour-blind user — where the `--v2-ink`/`--v2-ink-3` pair
                this replaces differ by ~3:1. The rail is the non-colour cue
                that makes brand ink acceptable, and it is the cue the drawer
                already uses. Both text states still clear AA at 12px on
                their own (6.29 and 5.32).

                It adds no height: `top-0` is inside the bar's `border-t` and
                the span is absolutely positioned, so `--v2-tab-bar-h` and the
                44px tap target the e2e spec asserts are untouched. */}
            {active && (
              <span
                aria-hidden="true"
                className="absolute inset-x-0 top-0 h-0.5 bg-[var(--v2-brand)]"
              />
            )}
            <span className="h-5 w-5" aria-hidden="true">
              {item.icon}
            </span>
            {/* `min-w-0` + `truncate` because the grid cell is the constraint,
                not the text: at 320px a cell is 64px and "Transactions" is
                wider than that, so without this it broke OUT of its cell and
                closed the gap to "Accounts" to 5.2px.

                `text-xs` is `--v2-text-meta`, the ramp's smallest step and the
                floor `design:lint` enforces. An earlier revision reached for
                two arbitrary sub-12px sizes, which made the widest label FIT at
                320 — and the micro-font ratchet allows zero of those. Since
                #2728 `design:lint:update` refuses to raise that baseline, so
                the choice is the ramp or a reviewed baseline edit, and a tab
                label is not the place to spend that. (The sizes are described
                rather than written here on purpose: the lint greps this file's
                text and cannot tell a class from a comment about one.)

                The cost is bounded and honest: at 320px "Transactions"
                ellipsises. That is the narrowest phone in the support matrix
                and the only width where it happens — at 390 the cell is 78px
                and the label fits whole. */}
            <span className="min-w-0 max-w-full truncate px-0.5">
              {item.label}
            </span>
          </Link>
        )
      })}
      {/* The fifth cell. Live, it is the More control; on the illustration it
          is a picture of one (the bar there is `inert`). The visible state
          follows the sheet: "More" with a menu glyph closed, "Close" with an
          X open, so a sighted user sees that the same cell now closes it. The
          closed state's visible "More" is not inside its accessible name
          `Open sidebar` (WCAG 2.5.3) — #2731's recorded trade, kept because
          the harness matches that name from every mobile capture. */}
      {more && !presentational ? (
        <button
          ref={more.buttonRef}
          type="button"
          onClick={more.onToggle}
          aria-label={more.open ? 'Close sidebar' : 'Open sidebar'}
          aria-expanded={more.open}
          aria-controls={more.open ? 'more-sheet' : undefined}
          data-more-toggle=""
          className={`relative flex h-[var(--v2-tab-bar-h)] flex-col items-center justify-center gap-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/80 ${
            more.open ? 'text-[var(--v2-brand)]' : 'text-[var(--v2-ink-3)]'
          }`}
        >
          {more.open && (
            <span aria-hidden="true" className="absolute inset-x-0 top-0 h-0.5 bg-[var(--v2-brand)]" />
          )}
          <span className="h-5 w-5" aria-hidden="true">
            <Icon icon={more.open ? X : Menu} className="w-full h-full" />
          </span>
          <span aria-hidden="true" className="min-w-0 max-w-full truncate px-0.5">
            {more.open ? 'Close' : 'More'}
          </span>
        </button>
      ) : presentational ? (
        <span className="flex h-[var(--v2-tab-bar-h)] flex-col items-center justify-center gap-1 text-xs font-medium text-[var(--v2-ink-3)]">
          <span className="h-5 w-5" aria-hidden="true">
            <Icon icon={Menu} className="w-full h-full" />
          </span>
          <span className="min-w-0 max-w-full truncate px-0.5">More</span>
        </span>
      ) : null}
    </nav>
  )
}
