'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Menu } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import type { NavItem } from './Sidebar'

/**
 * The primary navigation below `lg` (#2731).
 *
 * ## Why the "More" control is not in here
 *
 * It is a DOM SIBLING of this bar, rendered by `Sidebar`, and that is a
 * stacking-context fact rather than a preference. #2730's scale puts the bar on
 * the `--v2-z-tab-bar` tier so the drawer and its scrim cover it, and the
 * toggle on the higher `--v2-z-nav-toggle` tier so ONE control both opens and
 * closes the drawer it is painted over. A child cannot climb out of its
 * parent's stacking context, so the button has to live outside this element. This bar therefore lays out **five**
 * columns and fills four; the button occupies the fifth by geometry
 * (`w-1/5`, same height, same bottom edge), which is why the grid is
 * `grid-cols-5` and not `grid-cols-4`.
 *
 * ## Selection is by ROUTE, never by index
 *
 * `baseNavItems` is ordered for the drawer (Dashboard, Accounts, Transactions,
 * Agents); the bar's order is the issue's (Dashboard, Agents, Transactions,
 * Accounts). Reading it by position would silently reorder the bar the next
 * time someone inserts a drawer entry, so the tabs are picked by `href` and the
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
}: {
  items: NavItem[]
  presentational?: boolean
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
            aria-current={active ? 'page' : undefined}
            className={`flex h-[var(--v2-tab-bar-h)] flex-col items-center justify-center gap-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/80 ${
              active ? 'text-[var(--v2-ink)]' : 'text-[var(--v2-ink-3)]'
            }`}
          >
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
      {/* The fifth slot, ILLUSTRATION ONLY. The live bar leaves this cell empty
          and `Sidebar` paints the real control into it from outside, because
          that control has to outrank the drawer it opens. There is no drawer
          here, so the showcase can simply fill the cell — otherwise the
          illustration renders four tabs in a five-column grid and reads as a
          broken bar rather than as an explanation of why More is a sibling. */}
      {presentational ? (
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
