'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
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
}: {
  items: NavItem[]
  presentational?: boolean
}) {
  const pathname = usePathname() ?? ''
  const tabs = TAB_ROUTES.map((href) => items.find((i) => i.href === href)).filter(
    (i): i is NavItem => i !== undefined,
  )

  return (
    <nav
      aria-label={presentational ? undefined : 'Primary'}
      aria-hidden={presentational ? true : undefined}
      data-mobile-tab-bar=""
      className={`grid grid-cols-5 border-t border-[var(--v2-border)] bg-[var(--v2-bg)] ${
        presentational
          ? 'relative w-full'
          : 'lg:hidden fixed bottom-0 inset-x-0 z-[var(--v2-z-tab-bar)] pb-[var(--v2-safe-bottom)]'
      }`}
    >
      {tabs.map((item) => {
        const active = isActiveRoute(pathname, item.href)
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`flex h-[var(--v2-tab-bar-h)] flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/80 ${
              active ? 'text-[var(--v2-ink)]' : 'text-[var(--v2-ink-3)]'
            }`}
          >
            <span className="h-5 w-5" aria-hidden="true">
              {item.icon}
            </span>
            <span>{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
