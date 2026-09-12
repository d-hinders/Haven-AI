'use client'

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  ArrowLeftRight,
  BadgeCheck,
  Bot,
  CircleUserRound,
  EllipsisVertical,
  FileText,
  LayoutGrid,
  LogOut,
  Menu,
  X,
  Settings,
  ShieldCheck,
  Store,
  Users,
} from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { MobileTabBar } from './MobileTabBar'
import { useAuth } from '@/context/AuthContext'
import { displayName, userInitial as getUserInitial } from '@/lib/user'
import { HavenMark } from '@/components/brand/HavenMark'
import { Tooltip } from '@/components/ui/Tooltip'
import { useT } from '@/context/LocaleContext'
import { accountingFeedOffState, accountingNeedsAttention, useAccountingFeed } from '@/hooks/useAccountingFeed'

export interface NavItem {
  label: string
  href: string
  icon: React.ReactNode
  badge?: string
  /**
   * Full text for an abbreviated `badge`: the pill's accessible name, and
   * its visible text below `lg`, where the drawer is full-width and has the
   * room (#2869 design review — a `title` is unreachable on touch and to a
   * screen reader).
   */
  badgeTitle?: string
  /**
   * `brand` (default) is the live-count pill the Approvals entry used to
   * carry; `muted` is a marker, not a count — "Coming soon" on Accounting
   * while the feed is switched off (#2869).
   */
  badgeTone?: 'brand' | 'muted'
  /**
   * A small dot after the label, with this as its screen-reader text —
   * "needs attention" on Accounting when the destination needs a reconnect
   * or the retry sweep has given up on a row (#2869). Not a count: the
   * page says what, this only says "look".
   */
  attention?: string
}

// Lucide icons via the shared Icon convention (w/h-full fills the nav slot).
const icons = {
  dashboard: <Icon icon={LayoutGrid} className="w-full h-full" />,
  account: <Icon icon={ShieldCheck} className="w-full h-full" />,
  transactions: <Icon icon={ArrowLeftRight} className="w-full h-full" />,
  agents: <Icon icon={Bot} className="w-full h-full" />,
  catalog: <Icon icon={Store} className="w-full h-full" />,
  contacts: <Icon icon={Users} className="w-full h-full" />,
  profile: <Icon icon={CircleUserRound} className="w-full h-full" />,
  settings: <Icon icon={Settings} className="w-full h-full" />,
  logout: <Icon icon={LogOut} className="w-full h-full" />,
  dotsVertical: <Icon icon={EllipsisVertical} className="w-full h-full" />,
  accounting: <Icon icon={FileText} className="w-full h-full" />,
  custody: <Icon icon={BadgeCheck} className="w-full h-full" />,
}

/**
 * Exported for `MobileTabBar` (#2731), which picks its four tabs from this list
 * **by `href`**, never by position — the bar's order differs from the drawer's
 * and an inserted entry would otherwise reorder it silently. The index reads
 * inside `navGroups` below predate that and are left alone: they are grouped by
 * cluster, not selected by route, so they are a different kind of read.
 */
export const baseNavItems: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: icons.dashboard },
  { label: 'Accounts', href: '/accounts', icon: icons.account },
  { label: 'Transactions', href: '/transactions', icon: icons.transactions },
  { label: 'Agents', href: '/agents', icon: icons.agents },
  { label: 'Catalog', href: '/catalog', icon: icons.catalog },
  { label: 'Contacts', href: '/contacts', icon: icons.contacts },
  { label: 'Accounting', href: '/accounting', icon: icons.accounting },
  { label: 'Custody', href: '/custody', icon: icons.custody },
]

const DESKTOP_BREAKPOINT_PX = 1024

function NavLink({
  item,
  active,
  onClick,
}: {
  item: NavItem
  active: boolean
  onClick?: () => void
}) {
  return (
    <Link
      href={item.href}
      onClick={onClick}
      className={`relative overflow-hidden flex items-center gap-3 px-3 h-9 rounded-md text-[13px] font-medium transition-colors duration-150 ${
        active
          ? 'bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]'
          : 'text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)]'
      }`}
    >
      {active && (
        <span
          aria-hidden="true"
          className="absolute left-0 top-0 h-full w-0.5 rounded-r-full bg-[var(--v2-brand)]"
        />
      )}
      <span className={`inline-flex w-4 h-4 items-center justify-center flex-shrink-0 ${active ? 'text-[var(--v2-brand)]' : ''}`}>
        {item.icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.attention && (
        <span
          data-testid={`nav-attention${item.href.replace(/\//g, '-')}`}
          className="inline-flex h-2 w-2 flex-shrink-0 rounded-full bg-[var(--v2-warning)]"
        >
          <span className="sr-only"> {item.attention}</span>
        </span>
      )}
      {item.badge && (
        <span
          // `whitespace-nowrap`: the pill is a stadium, a one-line shape —
          // "Coming soon" wrapped to two lines in the first #2869 capture.
          className={`whitespace-nowrap flex-shrink-0 text-xs font-semibold leading-none px-1.5 py-0.5 rounded-full v2-tabular ${
            item.badgeTone === 'muted'
              ? 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-3)]'
              : 'bg-[var(--v2-brand)] text-white'
          }`}
        >
          {item.badgeTitle ? (
            // The abbreviation is for the 240px rail only; the full phrase
            // is what assistive tech reads and what the mobile drawer shows.
            <>
              <span aria-hidden="true" className="hidden lg:inline">{item.badge}</span>
              <span aria-hidden="true" className="lg:hidden">{item.badgeTitle}</span>
              {/* The leading space keeps the accessible name "Accounting Coming soon", not "AccountingComing soon". */}
              <span className="sr-only"> {item.badgeTitle}</span>
            </>
          ) : (
            item.badge
          )}
        </span>
      )}
    </Link>
  )
}

export default function Sidebar() {
  const t = useT()
  const pathname = usePathname()
  const router = useRouter()
  const { user, logout } = useAuth()
  // #2869: the Accounting entry reads the feed status for its markers. One
  // read per shell mount; the page refetches its own copy after Sync now,
  // this one refreshes on the next mount.
  const { status: accountingStatus, loading: accountingLoading } = useAccountingFeed()
  const [collapsed, setCollapsed] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < DESKTOP_BREAKPOINT_PX,
  )
  const [menuOpen, setMenuOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  const name = displayName(user)
  const userInitial = getUserInitial(user)
  const emailLine = user?.email ?? ''
  // Avoid showing the same value twice — if displayName resolves to email, hide the second line
  const showEmailLine = emailLine !== '' && name !== emailLine
  const profileActive = pathname === '/profile'

  // #1989 (epic #1440): the Approvals entry is GONE for every user, not hidden
  // per-account as #1079 had it. The approval queue was a legacy-rail
  // (AllowanceModule) concept and that rail is retired — `POST /approvals/:id/approve`
  // answers 410 (#1986) and the queue UI is deleted, so an entry point here
  // could only ever lead to a dead end. The delegation rail enforces budgets
  // on-chain and produces no approvals at all.

  // #2869: the Admin → Accounting entry in its three feed states.
  //   flag on               — plain, plus the attention dot when the
  //                           destination needs a reconnect or a sync is
  //                           `exhausted` (`accountingNeedsAttention`).
  //   hosted && !enabled    — still rendered, with a muted "Coming soon"
  //                           marker (owner decision 2026-09-11: visible in
  //                           production; exposure is a separate decision).
  //   !hosted               — HIDDEN. The feed is part of the hosted service
  //                           and nothing is scheduled for a self-hosted box,
  //                           so an entry would only lead to a page that says
  //                           so; `/accounting` still renders that copy by
  //                           URL.
  //   status pending        — NOTHING is rendered for the entry (#2869
  //                           review): a self-hosted answer would otherwise
  //                           remove an entry that had already painted, and
  //                           the rail would shift. A FAILED read renders the
  //                           plain entry — never a marker it has not earned.
  const accountingOff = accountingFeedOffState(accountingStatus)
  const accountingPending = accountingLoading && !accountingStatus
  const accountingItem: NavItem = {
    ...baseNavItems[6],
    ...(accountingOff === 'coming_soon'
      ? { badge: t.accountingPage.nav.comingSoon, badgeTitle: t.common.comingSoon, badgeTone: 'muted' as const }
      : accountingNeedsAttention(accountingStatus)
        ? { attention: t.accountingPage.nav.attention }
        : {}),
  }

  // Labeled clusters (#858): the core money loop first, tools and admin
  // after — same routes, same order within each cluster as before.
  const navGroups: Array<{ label: string; items: NavItem[] }> = [
    {
      label: 'Money',
      items: [
        baseNavItems[0], // Dashboard
        baseNavItems[1], // Accounts
        baseNavItems[2], // Transactions
        baseNavItems[3], // Agents
      ],
    },
    {
      label: 'Agent tools',
      items: [
        baseNavItems[4], // Catalog
        baseNavItems[5], // Contacts
      ],
    },
    {
      label: 'Admin',
      items: [
        // Accounting (#2869): markers per state; hidden on self-hosted; absent until the status has answered.
        ...(accountingPending || accountingOff === 'self_hosted' ? [] : [accountingItem]),
        baseNavItems[7], // Custody
      ],
    },
  ]

  // Keep the drawer honest across the `lg` breakpoint (#2586)
  /*
    Keep the drawer's state honest when the viewport CROSSES the breakpoint
    (#2586).

    `collapsed` was decided once, in the `useState` initialiser above, and never
    again. Below `lg` the drawer is `fixed inset-y-0 left-0` and only
    `-translate-x-full` keeps it off screen, so a window that STARTS at desktop
    width and then narrows leaves the drawer sitting on top of the page at
    `translate-x-0` — its footer row, the account link and the `User menu`
    kebab included. That is the overlap #2586 reports, and it obscures a real
    clickable link on the `/agents` empty state.

    It reproduces only after a CROSSING, which is why a fresh capture at 390
    looks clean and why no visual baseline could have caught it: the capture
    harness sets the viewport BEFORE it navigates, so the initialiser already
    sees the narrow width. Measured, with a positive control that a fresh mount
    at 390 does collapse — so the unchanged result on resize is the missing
    listener, not a probe that cannot see anything.

    `matchMedia` rather than a `resize` listener: it fires on the crossing
    itself, not on every intermediate pixel, so there is no per-frame work
    while a window is being dragged. Both directions are synced — going wide
    releases it (harmless, since `lg:translate-x-0` pins the drawer open at
    desktop regardless) so that a later narrowing is a real crossing again.

    The query is `min-width: 1024px` — Tailwind's OWN `lg` — and the result is
    negated, rather than the more obvious `max-width: 1023px` (review finding).
    Those two are not complements. At a fractional CSS viewport in [1023, 1024),
    which Windows display scaling and Chrome page zoom produce routinely, BOTH
    are false: measured at cssWidth 1023.2, `(min-width:1024px)` false and
    `(max-width:1023px)` false. With `max-width` the listener would then report
    "not mobile" while `lg:static` / `lg:translate-x-0` do not apply — so
    widening 390 -> 1023.2 would set `collapsed = false` and park the drawer on
    the page. That is worse than the bug being fixed: a REGRESSION at a width
    the old initialiser (`1023 < 1024`) handled correctly. Asking the same
    question the stylesheet asks cannot drift from it.

    `sync(query)` runs once at subscribe time, not only on later events —
    because the initialiser above and this query can DISAGREE at mount, on the
    same device, with no crossing involved. `window.innerWidth` is rounded;
    the media query is not. Measured in Chromium at
    `--force-device-scale-factor=1.1` with a device width of 1023:
    `window.innerWidth` reads 1024 — so the initialiser says desktop — while
    `(min-width: 1024px)` is false and `lg` does not apply. Without this line
    the drawer would sit over the page from first paint at that width, and
    nothing would correct it until the next real crossing.

    An earlier version of this comment justified the line by SSR instead:
    the initialiser returns `false` on the server, so a phone would hydrate
    open. That is wrong — React re-runs a `useState` initialiser on the client
    during hydration, so the client reaches the right value before this effect
    runs. The rounding case is the one that is provable, and it is what
    `Sidebar.test.tsx` pins.
  */
  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT_PX}px)`)
    const sync = (e: MediaQueryListEvent | MediaQueryList) => setCollapsed(!e.matches)
    sync(query)
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])

  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (popoverRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setMenuOpen(false)
    }
    const id = window.setTimeout(() => {
      window.addEventListener('mousedown', handler)
    }, 0)
    return () => {
      window.clearTimeout(id)
      window.removeEventListener('mousedown', handler)
    }
  }, [menuOpen])

  // Escape to close kebab popover, return focus to trigger
  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setMenuOpen(false)
        triggerRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [menuOpen])

  // Focus the first menu item when the kebab popover opens
  useEffect(() => {
    if (!menuOpen) return
    const first = popoverRef.current?.querySelector<HTMLElement>('[role="menuitem"]')
    first?.focus()
  }, [menuOpen])

  return (
    <>
      {/*
        Mobile toggle.

        Tap target (#1766). The control paints 32x32 — deliberately, because it
        shares a 56px bar with `NetworkSwitcher` and a larger visible box would
        crowd it — which left it 12px under the 44px comfort target
        `docs/product/design-system.md` § Buttons documents. It is not a
        `Button`, so it inherited none of #1726's mechanism; it borrows it here
        instead: a transparent `::after` extends the HIT area to 44x44 while the
        painted pixels stay exactly where they were.

        Two deliberate deviations from `Button`'s version of the same trick:

        1. **The target grows in BOTH axes**, where `Button` grows vertically
           only. That rule exists because an `sm` Button's width already clears
           44px once it carries a label, so widening it would only let it steal
           a neighbour's taps in a tight toolbar. Neither half holds for an
           icon-only 32px square: its width is the short axis too, and the
           nearest interactive control in this bar starts at x=68, which leaves
           14px of clearance beyond the 44px target's right edge (x=54). The
           mobile spec asserts that clearance so a future move of either control
           cannot quietly close it.
        2. **No `relative`.** `Button` adds it to create a positioning context;
           `fixed` already is one, and adding `relative` here would un-fix the
           button and drop it back under `TopBar` — the #1749 defect, restored.
        3. **`top-3 left-4`, and the `left` is deliberate (#1767).** `top-3`
           centres the 32px box in the 56px bar (y 12-44, centre 28 — it was
           `top-4` and 4px low). The obvious matching change, `left-6`, would
           make the box concentric with `TopBar`'s `w-8` spacer (x 24-56), and
           it was measured and REJECTED: it costs 8px of the 44px target's
           right-hand clearance (14px -> 6px, under the 8px § Buttons asks
           between adjacent targets) AND it pushes the target's right edge from
           x=54 to x=62, past the centre of the open drawer's own Haven logo
           link at x=56 — turning the last assertion in the mobile spec red.
           The spacer's job is to keep the bar's content CLEAR of this control,
           not to be concentric with it; `left-4` is what clears it best.
      */}
      {/*
        The tab bar's fifth slot — "More" (#2731).

        It is a SIBLING of `<MobileTabBar>` rather than a cell inside it, and
        that is forced rather than chosen: the bar sits on the `--v2-z-tab-bar`
        tier so the drawer and its scrim cover it, while this control sits on
        the higher `--v2-z-nav-toggle` tier so the SAME button that opened the
        drawer can close it while painted over the drawer. A child cannot climb
        out of its parent's stacking context, so a control on the toggle tier
        cannot be nested inside an element on the bar tier — it lives out here
        and lands in the fifth column by geometry: `w-1/5` of the same bar, same
        bottom edge, same height.

        (The tier VALUES are deliberately not written out here. `z-index-scale`
        greps this file for bare `z-<number>` and cannot tell a class from
        prose — it read the numbers in an earlier draft of this comment as
        violations. The scale itself is documented on `/design-system`.)

        Two geometry facts, both found by review rather than predicted:

        `bottom-[var(--v2-safe-bottom)]` + `h-[var(--v2-tab-bar-h)]`, NOT a
        height of `calc(bar + inset)` with `pb-[inset]`. The padding version
        kept the CONTENT out of the home-indicator band and left the BOX in it:
        the button reached y=844 on a 393x844 device with a 34px inset, so the
        fifth slot had 34px more tappable area than its four neighbours and a
        tap in that band is read by iOS as a swipe-up. That is the exact defect
        #2730 exists to prevent, reintroduced for one control — and
        `safe-area-insets.mobile.spec.ts` caught it with an assertion nobody
        had to change.

        No `border-t` here. The bar draws one, this button is `border-box` and
        paints over the bar's right fifth, so its own border landed one CSS
        pixel below the bar's and the fifth slot showed a 2px top edge against
        1px everywhere else — a visible step. Without it the bar's own border
        runs unbroken underneath.

        The surface FOLLOWS the drawer (#2820). Closed, the button paints
        `--v2-bg` — byte-identical to the bar slot it was before #2820, and
        `MobileTabBar` paints the same token, so the fifth slot does not change
        colour against its four neighbours. Open, it is transparent: the
        control floats on the `--v2-z-nav-toggle` tier over the now full-width
        drawer, and with the scrim gone there is no page behind it — an opaque
        box there is exactly the detached white rectangle the issue names,
        belonging to neither the drawer nor the bar. A background that exists
        only while the drawer is closed lets the single control belong to
        whichever surface is showing.

        The accessible name is unchanged, and that is load-bearing rather than
        incidental: `dismissMobileSidebar` in `scripts/screenshot.mjs` waits on
        `getByRole('button', { name: 'Open sidebar' })` from 25 call sites, with
        a twin in `e2e/fixtures/haven-api.ts`. Neither file is touched by
        #2731 — one control, both roles, the #1749 pattern.
      */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        aria-label={collapsed ? 'Open sidebar' : 'Close sidebar'}
        className={`lg:hidden fixed bottom-[var(--v2-safe-bottom)] right-[var(--v2-safe-right)] z-[var(--v2-z-nav-toggle)] w-1/5 h-[var(--v2-tab-bar-h)] flex flex-col items-center justify-center gap-1 text-xs font-medium text-[var(--v2-ink-3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/80 ${
          collapsed ? 'bg-[var(--v2-bg)]' : 'bg-transparent'
        }`}
      >
        {/* The visible state follows the drawer (#2731 review). It used to
            read "More" with a hamburger in BOTH states while the accessible
            name flipped to `Close sidebar` — a sighted user got no affordance
            that the control now closes something, and the visible label no
            longer appeared in the accessible name at all (WCAG 2.5.3 Label in
            Name).

            The open state satisfies that rule now ("Close" is inside "Close
            sidebar"). The CLOSED state deliberately does not: "More" is not
            inside "Open sidebar". That pairing is #2731's own specification —
            the tab is called More, and the accessible name must stay exactly
            `Open sidebar` because `dismissMobileSidebar` matches it as a whole
            string from 25 call sites. Recorded rather than quietly resolved,
            because resolving it means changing one of those two decisions. */}
        <span className="h-5 w-5" aria-hidden="true">
          <Icon icon={collapsed ? Menu : X} className="w-full h-full" />
        </span>
        <span aria-hidden="true">{collapsed ? 'More' : 'Close'}</span>
      </button>

      {/*
        Overlay for mobile — the same `v2-modal-backdrop` Modal and SidePanel use.

        It was `bg-[var(--v2-ink)]/40 backdrop-blur-sm`, an opacity modifier on a
        bare var(), which Tailwind v3.4 drops silently (#1818): the scrim had no
        background at all, so the drawer opened over an undimmed page.

        Fixing it onto `bg-ink/40` would have worked, but it would have shipped a
        SECOND overlay convention — and worse, it would have made the blur real.
        `backdrop-blur-sm` was never free by intent, only by accident: with no
        background painted there was nothing to composite. Painting one activates
        a full-viewport `backdrop-filter` on a `fixed inset-0` element, which is
        exactly what globals.css's `.v2-modal-backdrop` documents avoiding — the
        compositor keeps a GPU snapshot of the whole page and re-blurs it every
        paint. So this reuses the existing dim token instead, blur included in
        what it deliberately omits.
      */}
      {/*
        No scrim below `lg` (#2820).

        The drawer used to slide over a `v2-modal-backdrop` sheet — the right
        answer while it was a 240px column, and a defect once #2731 made it
        "More": at 390px the sheet left ~150px of dimmed page down the right
        edge, so the app's own navigation read as a slide-over, and the toggle
        read as a detached bright rectangle belonging to neither surface. The
        drawer is `w-full` below `lg` now, so there is nothing left to dim: the
        drawer IS the screen, and the only thing beneath it at full width is the
        tab bar it opened from.

        --v2-z-nav-scrim stays in the scale untouched. Its only consumer was
        this element, and the tier it occupies is still real ordering —
        `z-index-scale.test.ts` asserts the ascent through it, and retiring a
        tier because its consumer left would renumber the scale for nothing.
      */}

      <MobileTabBar items={baseNavItems} />

      {/*
        Safe-area insets on the drawer (#2730), below `lg` only — at `lg` this
        is a static column inside the shell and the shell's own chrome already
        clears the screen edges.

        The drawer is `inset-y-0 h-screen` and, in an installed standalone
        context, `h-screen` is the WHOLE screen: its logo band would sit under
        the status bar and its footer row — the account link and the `User
        menu` kebab, which #2586 already had to rescue once — under the home
        indicator. Padding on the `<aside>` itself rather than on the two rows
        it protects, because the middle `<nav>` is `flex-1 overflow-y-auto`:
        with `box-sizing: border-box` the padding comes out of the scroll
        region's height, so both ends clear their obstruction and the scroll
        region absorbs the difference. `pl` covers the landscape notch, where
        the drawer is on the eaten side.

        The drawer is `w-full` below `lg` (#2820). Under #2731 the tab bar is
        primary navigation and this surface is "More" — and at 390pt a 240px
        column sliding over a scrim is a desktop artifact: ~150px of dimmed
        page down the right edge, a dead middle band, and the toggle reading as
        a detached bright rectangle. Full width is also the iOS idiom for a
        tab bar's More: a full-height sheet, not a slide-over. `w-full` below
        the breakpoint and `lg:w-[240px]` at it keeps the desktop column
        byte-identical; there is no desktop behaviour in the diff at all.

        Two #2820 consequences live in the classes below:

        1. `max-lg:border-r-0`. The 1px `border-r` was the column's edge
           against the page. Full width, it is a stray vertical line inside the
           screen's right edge, and `--v2-border` on `--v2-surface` is visible
           against both. The border returns at `lg` with the column.

        2. The footer's `max-lg:pr-[calc(20%+var(--v2-safe-right))]`. The
           Close toggle is `fixed w-1/5` on a higher tier and floats over the
           drawer's bottom-right corner below `lg` — without a yield it covers
           the user card's kebab, an interactive control under an invisible
           hit area, the #1749 defect class one surface over. 20% is exactly
           the toggle's fifth-of-a-screen column; at `lg` the toggle is
           `lg:hidden`, so the padding must not exist there. The `Settings`
           row above carries the same reserve so the two footer rows keep
           their shared right edge.

        The nav's `max-lg:flex max-lg:flex-col` + the groups' `max-lg:my-auto`
        kill the dead middle band (#2820 item 2): the desktop column is taller
        than its content, so the footer sat at the bottom and everything above
        it left a gap roughly as tall as the nav itself. Auto margins
        distribute the free space evenly BETWEEN the groups (top and bottom
        margins cancel pairwise), dropping the first group back to the logo
        and pinning the last against the footer — on a phone, where the nav
        has less room than it wants, they resolve to 0 and the list is simply
        top-aligned, so `overflow-y-auto` keeps doing its job and short or
        landscape viewports cannot clip the top the way a `justify-evenly`
        distribution would.
      */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-[var(--v2-z-nav-drawer)] w-full lg:w-[240px] h-screen lg:h-full max-lg:border-r-0 max-lg:pt-[var(--v2-safe-top)] max-lg:pb-[var(--v2-safe-bottom)] max-lg:pl-[var(--v2-safe-left)] bg-[var(--v2-surface)] lg:border-r border-[var(--v2-border)] flex flex-col flex-shrink-0 transition-transform duration-200 ${
          collapsed ? '-translate-x-full lg:translate-x-0' : 'translate-x-0'
        }`}
      >
        {/* Logo */}
        <div className="h-14 flex items-center px-5 flex-shrink-0">
          <Link
            href="/dashboard"
            className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-[var(--v2-ink)]"
          >
            <HavenMark />
            <span className="v2-brand-gradient-text">Haven</span>
          </Link>
        </div>

        {/* Main nav — labeled clusters, core money loop first (#858) */}
        {/* Named because #2731 gave the shell a SECOND navigation. Two
            unnamed `<nav>` landmarks are ambiguous to a screen reader and to
            every `getByRole('navigation')` in the suite — `Sidebar.test.tsx`
            was reading `document.querySelector('nav')` and silently started
            measuring the tab bar instead of this drawer. */}
        {/* `max-lg:flex max-lg:flex-col` (#2820): below `lg` the free vertical
            space of the drawer's dead middle band is distributed evenly
            BETWEEN the groups by each group's `max-lg:my-auto` (see the
            aside's comment above). At `lg` the column is a fixed 240px rail
            and the block layout is byte-identical to pre-#2820. */}
        <nav
          aria-label="All sections"
          className="flex-1 px-3 py-4 overflow-y-auto max-lg:flex max-lg:flex-col"
        >
          {navGroups.map((group, groupIndex) => (
            <div key={group.label} className={groupIndex > 0 ? 'mt-5 max-lg:my-auto' : 'max-lg:my-auto'}>
              <p className="v2-text-meta px-3 pb-1 uppercase tracking-wider text-[var(--v2-ink-3)]">
                {group.label}
              </p>
              <div className="space-y-1">
                {group.items.map((item) => {
                  const active = pathname === item.href || pathname.startsWith(item.href + '/')
                  return (
                    <NavLink
                      key={item.href}
                      item={item}
                      active={active}
                      onClick={() => setCollapsed(true)}
                    />
                  )
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Bottom section */}
        {/* `max-lg:pr-[calc(20%+var(--v2-safe-right))]` (#2820): the Close
            toggle is `fixed w-1/5` on the `--v2-z-nav-toggle` tier and floats
            over the full-width drawer's bottom-right corner below `lg`. This
            yield keeps the kebab — an interactive control — clear of its hit
            area. The `Settings` row below carries the same reserve, so the
            footer's two rows keep a shared right edge. `lg` needs none: the
            toggle is `lg:hidden` there. */}
        <div className="flex-shrink-0 border-t border-[var(--v2-border)] max-lg:pr-[calc(20%+var(--v2-safe-right))]">
          {/* Settings */}
          <div className="px-3 py-2 max-lg:pr-0">
            <NavLink
              item={{ label: 'Settings', href: '/settings', icon: icons.settings }}
              active={pathname === '/settings'}
              onClick={() => setCollapsed(true)}
            />
          </div>

          {/* User card with kebab */}
          <div className="px-3 pb-4 pt-1">
            <div className={`relative flex items-center gap-2 rounded-md transition-colors duration-150 ${
              profileActive
                ? 'bg-[var(--v2-brand-soft)]'
                : 'hover:bg-[var(--v2-surface-hover)]'
            }`}>
              {profileActive && (
                <span
                  aria-hidden="true"
                  className="absolute left-0 top-0 h-full w-0.5 rounded-r-full bg-[var(--v2-brand)]"
                />
              )}
              <Link
                href="/profile"
                onClick={() => setCollapsed(true)}
                aria-label={`Open profile for ${name}`}
                aria-current={profileActive ? 'page' : undefined}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2"
              >
                {/* Avatar */}
                <div className="w-8 h-8 rounded-full bg-[var(--v2-brand)] flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
                  {userInitial}
                </div>

                {/* Name + email */}
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium text-[var(--v2-ink)] truncate leading-tight">
                    {name}
                  </p>
                  {showEmailLine && (
                    <p className="mt-0.5 truncate text-xs leading-tight text-[var(--v2-ink-3)]">
                      {emailLine}
                    </p>
                  )}
                </div>
              </Link>

              {/* Kebab trigger */}
              <div className="relative pr-2">
                <Tooltip label="Account menu" side="top">
                  <button
                    ref={triggerRef}
                    type="button"
                    onClick={() => setMenuOpen((v) => !v)}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    aria-label="User menu"
                    className="w-7 h-7 flex items-center justify-center rounded-md text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)] focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:outline-none transition-colors"
                  >
                    <span className="inline-flex w-4 h-4 items-center justify-center">
                      {icons.dotsVertical}
                    </span>
                  </button>
                </Tooltip>

                {/* Kebab popover — opens upward */}
                {menuOpen && (
                  <div
                    ref={popoverRef}
                    role="menu"
                    aria-label="User menu"
                    className="absolute bottom-full right-0 mb-2 w-44 bg-[var(--v2-bg)] border border-[var(--v2-border)] rounded-lg shadow-popover px-1 py-1 z-[var(--v2-z-chrome-popover)]"
                  >
                    <Link
                      href="/profile"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false)
                        setCollapsed(true)
                      }}
                      className="flex items-center gap-2 px-3 py-2 text-[13px] text-[var(--v2-ink)] hover:bg-[var(--v2-surface)] w-full text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/80"
                    >
                      <span className="inline-flex w-3.5 h-3.5 items-center justify-center flex-shrink-0">
                        {icons.profile}
                      </span>
                      Profile
                    </Link>
                    <Link
                      href="/settings"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false)
                        setCollapsed(true)
                      }}
                      className="flex items-center gap-2 px-3 py-2 text-[13px] text-[var(--v2-ink)] hover:bg-[var(--v2-surface)] w-full text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/80"
                    >
                      <span className="inline-flex w-3.5 h-3.5 items-center justify-center flex-shrink-0">
                        {icons.settings}
                      </span>
                      Settings
                    </Link>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false)
                        logout()
                        router.push('/')
                      }}
                      className="flex items-center gap-2 px-3 py-2 text-[13px] text-[var(--v2-danger)] hover:bg-[var(--v2-danger-soft)] w-full text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-danger/80"
                    >
                      <span className="inline-flex w-3.5 h-3.5 items-center justify-center flex-shrink-0">
                        {icons.logout}
                      </span>
                      Log out
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </aside>
    </>
  )
}
