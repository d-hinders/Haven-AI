'use client'

import type { RefObject } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Menu } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import type { NavItem } from './Sidebar'

/**
 * The primary navigation below `lg` (#2731).
 *
 * ## A floating pill (#4058)
 *
 * The bar floats: inset from the sides, `--v2-tab-bar-bottom` above the
 * viewport bottom (12px, or the home-indicator inset on a notched phone),
 * `rounded-full` with a border and the popover shadow, and capped at `max-w-md`
 * and centred so a 1000px tablet does not get 200px cells. It is still the
 * `fixed` `<nav data-mobile-tab-bar>` itself, not a wrapper around an inner
 * pill: specs select `nav.fixed[data-mobile-tab-bar]`. The pill paints from
 * its own token pair (#4063): light it is SOLID `--v2-tab-bar-bg` — exactly
 * `--v2-bg` — with a `--v2-tab-bar-border` edge, because the popover shadow
 * alone lifts it there. Dark redeclares both: `--v2-surface-2` fill and the
 * `--v2-border-strong` edge, because the dark shadow is black on near-black
 * and plain `--v2-border` measured only 1.41:1 against `--v2-bg` (the edge is
 * 1.79:1, the fill 1.19:1). With NO `backdrop-filter`: the owner chose
 * near-solid over glass, and a blur is out because the installed-iOS
 * stale-frame class `SafeAreaBand` documents cannot be tested by any CI
 * engine. Without a blur, even 95% opacity let page text ghost through behind
 * the labels (measured at 390px on `/agents`), so the pill stays opaque — a
 * translucent fill would ghost page text behind the labels again.
 *
 * ## "More" is the fifth cell, and only opens (#4053, #4058)
 *
 * Until #4053 the More control was a DOM sibling of this bar, painted into
 * the fifth column from outside on the higher `--v2-z-nav-toggle` tier,
 * because #2820's full-screen drawer covered the bar. #4053 made it an
 * ordinary cell beside the four tabs. Since #4058 the sheet it opens floats
 * OVER the bar again — with a full-height scrim and its own ✕ — so the cell
 * only ever opens: its name is a constant `Open sidebar` (`aria-expanded`
 * carries the state), and `Close sidebar` belongs to the sheet's ✕ alone. Two
 * buttons with that name would break Playwright's strict mode in the harness.
 *
 * ## Selection is by ROUTE, never by index
 *
 * `baseNavItems` is ordered for the rail (Dashboard, Analytics, Accounts,
 * Transactions, Accounting, Agents, Marketplace, Contacts — regrouped by #3024,
 * Analytics from #2947; Marketplace renamed from Catalog by #3079); the bar's
 * order is the issue's (Dashboard — labelled "Home" in the bar since #4237 —
 * Agents, Transactions — labelled Activity since
 * #4058 — Accounts), unchanged by that
 * regroup. Reading it by position would silently reorder the bar the next
 * time someone inserts a rail entry, so the tabs are picked by `href` and the
 * lookup throws nothing — a route that disappears simply drops out, and the
 * count assertion in the e2e spec is what notices.
 */
export const TAB_ROUTES = ['/dashboard', '/agents', '/transactions', '/accounts'] as const

/**
 * Bar-only labels (#4058, #4237 — owner decisions). "Transactions" truncated
 * in the pill at 390px and already did at 375px (bug report 2026-10-14, N2);
 * the bar says "Activity" while the rail, the page title and the route stay
 * "Transactions". "Dashboard" is shortened to "Home" so the concentric
 * capsule's curved ends (#4237) stay off the landing tab's label — the same
 * trade #4058 made with `rounded-2xl`, which the capsule replaces. The rail,
 * the page `h1` and the route keep "Dashboard".
 */
export const TAB_LABELS: Partial<Record<(typeof TAB_ROUTES)[number], string>> = {
  '/dashboard': 'Home',
  '/transactions': 'Activity',
}

/**
 * Active for the hub AND its detail pages: `/agents/agent-research` lights
 * Agents. Prefix-matched on a `/` boundary so `/accounts` never lights for a
 * hypothetical `/accounts-archive`.
 */
export function isActiveRoute(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}

/**
 * A cell is a full RECTANGLE of the grid, and the active shape is painted by an
 * indicator span inside it (#4058). Chromium hit-tests `border-radius`, so a
 * `rounded-full` cell left its four corners dead — taps there fell through to
 * the bar — and the e2e corner probes caught it. The cells abut (no gap), so
 * there is no dead strip between them either.
 *
 * The FONT WEIGHT is deliberately not here: an inactive and an active cell
 * share this string, and `font-medium` and `font-semibold` on one element
 * resolve by CSS order, not by specificity (#4237). Weight is applied per
 * cell below — inactive and More are `font-medium` (500), the active tab
 * `font-semibold` (600).
 */
const CELL =
  'group relative flex h-[3.25rem] min-w-0 flex-col items-center justify-center gap-0.5 text-xs transition-colors focus-visible:outline-none'

/**
 * The indicator carries the selection AND the focus ring (#4237, owner
 * decision: Revolut's tab bar). Active: a full `rounded-full` CAPSULE filled
 * with the neutral `--v2-tab-bar-indicator` — no outline. Set in from the
 * pill by the same 5px on every side (`p-1` padding + the 1px border), so
 * its 26px radius is concentric with the pill's 31px and its curve follows
 * the pill's. Focused: the system's outset `ring-2 ring-brand/80`.
 *
 * The FILL is a supplementary cue, never the carrier of the selection. A
 * subtle neutral fill cannot reach WCAG 1.4.11's 3:1 non-text contrast
 * against the pill without becoming a heavy block — the owner declined the
 * brand tint that reached for that. Selection is carried by three cues on
 * the cell itself:
 *
 *   | Cue          | Active              | Inactive    |
 *   |--------------|---------------------|-------------|
 *   | Luminance    | `--v2-ink`          | `--v2-ink-3` |
 *   | Weight       | 600                 | 500         |
 *   | Programmatic | `aria-current="page"` | none      |
 *
 * `--v2-ink` vs `--v2-ink-3` measures 3.05:1 in light and 2.50:1 in dark, so
 * in dark mode the weight is load-bearing. The fill itself measures 1.12:1
 * (light) / 1.18:1 (dark) against `--v2-tab-bar-bg`; the text states both
 * clear 4.5:1 on their grounds (pinned in `CONTRAST_PAIRS`: ink on
 * `tab-bar-indicator`, ink-3 on `tab-bar-bg`). Icon and label are `relative`,
 * so they paint above this absolutely placed span.
 */
function indicatorClass(active: boolean): string {
  return `absolute inset-0 rounded-full group-focus-visible:ring-2 group-focus-visible:ring-brand/80 ${
    active ? 'bg-[var(--v2-tab-bar-indicator)]' : ''
  }`
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
      className={`grid max-w-md grid-cols-5 rounded-full border border-[var(--v2-tab-bar-border)] bg-[var(--v2-tab-bar-bg)] p-1 shadow-popover ${
        presentational
          ? 'relative mx-auto w-full'
          : 'lg:hidden fixed left-[max(0.75rem,var(--v2-safe-left))] right-[max(0.75rem,var(--v2-safe-right))] bottom-[var(--v2-tab-bar-bottom)] mx-auto z-[var(--v2-z-tab-bar)]'
      }`}
    >
      {tabs.map((item) => {
        const active = isActiveRoute(pathname, item.href)
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`${CELL} ${active ? 'text-[var(--v2-ink)] font-semibold' : 'text-[var(--v2-ink-3)] font-medium hover:text-[var(--v2-ink)]'}`}
          >
            {/* The bar's selection idiom is its own (#4237, owner decision —
                Revolut's tab bar): a neutral concentric CAPSULE
                (`--v2-tab-bar-indicator`), not the brand-soft + outline idiom
                the rest of the app's selections use. The "one active idiom"
                rule (#2818) is deliberately relaxed for the bar: the More
                sheet's rows keep their brand tint (`MoreSheet`), and since the
                sheet covers the bar while open the two idioms are never on
                screen together — co-visibility was #2818's failure case.
                `SegmentedControl` itself is untouched. It replaced a 2px rail
                across the cell's top edge, which an edge-less floating pill
                has nowhere to hang (and then the #4058 brand-soft+outline
                indicator).

                The fill is NOT the carrier of the selection — see the
                accessibility position on `indicatorClass`: a subtle neutral
                fill cannot reach WCAG 1.4.11's 3:1 without becoming a heavy
                block, which is the owner's call against brand tint.
                Selection rides on the cell's ink (`--v2-ink` vs `--v2-ink-3`,
                3.05:1 light / 2.50:1 dark — in dark mode the weight is
                load-bearing), the 600/500 weight step, and
                `aria-current="page"`. Every cell's focus ring is OUTSET and
                painted on the INDICATOR — see `indicatorClass`. */}
            <span aria-hidden="true" data-tab-indicator="" className={indicatorClass(active)} />
            <span className="relative h-5 w-5" aria-hidden="true">
              {item.icon}
            </span>
            {/* `min-w-0` + `truncate` because the grid cell is the constraint,
                not the text: at 320px a cell is under 60px inside the pill,
                and an over-long label would otherwise break OUT of its cell
                and close the gap to its neighbour.

                `text-xs` is `--v2-text-meta`, the ramp's smallest step and the
                floor `design:lint` enforces. An earlier revision reached for
                two arbitrary sub-12px sizes, which made the widest label FIT at
                320 — and the micro-font ratchet allows zero of those. Since
                #2728 `design:lint:update` refuses to raise that baseline, so
                the choice is the ramp or a reviewed baseline edit, and a tab
                label is not the place to spend that. (The sizes are described
                rather than written here on purpose: the lint greps this file's
                text and cannot tell a class from a comment about one.)

                So the label and the padding give, not the font: the bar says
                "Activity" and "Home" (`TAB_LABELS`, #4058/#4237), the label
                span carries no side padding, and the pill pads 4px on every
                side. #4237 widened the side padding from 2px to 4px to make
                the capsule concentric, narrowing each cell by about 1.6px —
                the per-tab fit check in `navigation.mobile.spec.ts` is what
                catches any label that cost.
                Every label renders whole from 375px up. 320px, the narrowest phone in the support matrix, is
                reported in the PR rather than promised here. */}
            <span className="relative min-w-0 max-w-full truncate">
              {TAB_LABELS[item.href as (typeof TAB_ROUTES)[number]] ?? item.label}
            </span>
          </Link>
        )
      })}
      {/* The fifth cell. Live, it is the More control; on the illustration it
          is a picture of one (the bar there is `inert`). It only OPENS
          (#4058): the sheet it opens covers the bar and carries its own ✕, so
          the cell never turns into "Close" — its name is the constant
          `Open sidebar`, with `aria-expanded` for the state. The visible
          "More" is not inside that name (WCAG 2.5.3) — #2731's recorded trade,
          kept because the harness matches that name from every mobile
          capture. */}
      {more && !presentational ? (
        <button
          ref={more.buttonRef}
          type="button"
          onClick={more.onToggle}
          aria-label="Open sidebar"
          aria-expanded={more.open}
          aria-controls={more.open ? 'more-sheet' : undefined}
          data-more-toggle=""
          className={`${CELL} font-medium text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)]`}
        >
          <span aria-hidden="true" data-tab-indicator="" className={indicatorClass(false)} />
          <span className="relative h-5 w-5" aria-hidden="true">
            <Icon icon={Menu} className="w-full h-full" />
          </span>
          <span aria-hidden="true" className="relative min-w-0 max-w-full truncate">
            More
          </span>
        </button>
      ) : presentational ? (
        <span className={`${CELL} font-medium text-[var(--v2-ink-3)]`}>
          <span className="h-5 w-5" aria-hidden="true">
            <Icon icon={Menu} className="w-full h-full" />
          </span>
          <span className="relative min-w-0 max-w-full truncate">More</span>
        </span>
      ) : null}
    </nav>
  )
}
