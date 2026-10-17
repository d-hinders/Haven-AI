'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  ArrowLeftRight,
  Bot,
  ChartColumn,
  CircleUserRound,
  EllipsisVertical,
  FileText,
  LayoutGrid,
  LogOut,
  Settings,
  ShieldCheck,
  Store,
  Users,
} from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { MobileTabBar, TAB_ROUTES, isActiveRoute } from './MobileTabBar'
import { MoreSheet } from './MoreSheet'
import { ThemeToggle } from '@/components/ui/ThemeToggle'
import EnvBadge from '@/components/EnvBadge'
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
   * its visible text in the phone More sheet, which has the room (#2869
   * design review — a `title` is unreachable on touch and to a screen
   * reader).
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
  analytics: <Icon icon={ChartColumn} className="w-full h-full" />,
  agents: <Icon icon={Bot} className="w-full h-full" />,
  marketplace: <Icon icon={Store} className="w-full h-full" />,
  contacts: <Icon icon={Users} className="w-full h-full" />,
  profile: <Icon icon={CircleUserRound} className="w-full h-full" />,
  settings: <Icon icon={Settings} className="w-full h-full" />,
  logout: <Icon icon={LogOut} className="w-full h-full" />,
  dotsVertical: <Icon icon={EllipsisVertical} className="w-full h-full" />,
  accounting: <Icon icon={FileText} className="w-full h-full" />,
}

/**
 * Exported for `MobileTabBar` (#2731), which picks its four tabs from this list
 * **by `href`**, never by position — the bar's order differs from the rail's
 * and an inserted entry would otherwise reorder it silently. The index reads
 * inside `navGroups` below predate that and are left alone: they are grouped by
 * cluster, not selected by route, so they are a different kind of read.
 *
 * Order regrouped by #3024 (owner decision 2026-09-15) to match what the
 * pages do rather than the accident of when each shipped: Dashboard and
 * Analytics are "how are things" (#3024 wrote them down as an Overview group
 * the moment Analytics shipped, which #2947 did first); Accounts,
 * Transactions and Accounting are "my money and its record"; Agents, Marketplace and Contacts are "what I let
 * agents do and with whom" — on the delegation rail an agent only ever pays a
 * contact, so Marketplace and Contacts are the two answers to "where can the
 * money go" (Marketplace renamed from Catalog by #3079). Custody is gone outright (#3024): its two facts, the account's
 * signer set and each agent's delegation terms, already render on
 * `/accounts/:id` and `/agents/:id`.
 */
export const baseNavItems: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: icons.dashboard },
  { label: 'Analytics', href: '/analytics', icon: icons.analytics },
  { label: 'Accounts', href: '/accounts', icon: icons.account },
  { label: 'Transactions', href: '/transactions', icon: icons.transactions },
  { label: 'Accounting', href: '/accounting', icon: icons.accounting },
  { label: 'Agents', href: '/agents', icon: icons.agents },
  // #3079: renamed from Catalog. Same index, same route slot — `/catalog`
  // permanently redirects to `/marketplace` (next.config.ts `redirects()`).
  { label: 'Marketplace', href: '/marketplace', icon: icons.marketplace },
  { label: 'Contacts', href: '/contacts', icon: icons.contacts },
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
              : 'bg-[var(--v2-brand)] text-[var(--v2-ink-on-brand)]'
          }`}
        >
          {item.badgeTitle ? (
            // The abbreviation is for the 240px rail; the full phrase is what
            // assistive tech reads (and what the phone sheet shows, #4053).
            <>
              <span aria-hidden="true">{item.badge}</span>
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
  // The phone More sheet (#4053). It only ever opens below `lg`: `sheetOpen`
  // is the conjunction, so a sheet left open across a widening cannot render
  // on desktop even for the frame before the crossing listener closes it.
  const [moreOpen, setMoreOpen] = useState(false)
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && window.innerWidth >= DESKTOP_BREAKPOINT_PX,
  )
  const sheetOpen = moreOpen && !isDesktop
  const closeMore = useCallback(() => setMoreOpen(false), [])
  const moreButtonRef = useRef<HTMLButtonElement>(null)
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

  // #2869: the Accounting entry (last item of the Money group since #3024)
  // in its three feed states.
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
    ...baseNavItems[4],
    ...(accountingOff === 'coming_soon'
      ? { badge: t.accountingPage.nav.comingSoon, badgeTitle: t.common.comingSoon, badgeTone: 'muted' as const }
      : accountingNeedsAttention(accountingStatus)
        ? { attention: t.accountingPage.nav.attention }
        : {}),
  }

  // Labeled clusters, regrouped by #3024 (owner decision 2026-09-15) to match
  // the user's mental model rather than a "core loop vs. tools vs. admin"
  // split that no longer fit once Custody was the only thing left in Admin:
  // Overview is "how are things"; Money is "my money and its record"; Agents
  // is "what I let agents do and with whom". Re-derived from `baseNavItems`' new order
  // below rather than renumbered by hand — the file's own rule, restated
  // above the array.
  const navGroups: Array<{ label: string; items: NavItem[] }> = [
    {
      label: t.sidebar.overviewGroup,
      items: [
        baseNavItems[0], // Dashboard
        baseNavItems[1], // Analytics
      ],
    },
    {
      label: t.sidebar.moneyGroup,
      items: [
        baseNavItems[2], // Accounts
        baseNavItems[3], // Transactions
        // Accounting (#2869): markers per state; hidden on self-hosted; absent until the status has answered.
        ...(accountingPending || accountingOff === 'self_hosted' ? [] : [accountingItem]),
      ],
    },
    {
      label: t.sidebar.agentsGroup,
      items: [
        baseNavItems[5], // Agents
        baseNavItems[6], // Marketplace
        baseNavItems[7], // Contacts
      ],
    },
  ]

  /*
    Which side of `lg` the viewport is on, kept honest across a CROSSING
    (#2586) and at mount.

    `matchMedia` rather than a `resize` listener: it fires on the crossing
    itself, not on every intermediate pixel. The query is `min-width: 1024px`
    — Tailwind's OWN `lg` — rather than `max-width: 1023px`: at a fractional
    CSS viewport in [1023, 1024), which display scaling and page zoom produce
    routinely, both of those are false, and asking the question the
    stylesheet asks cannot drift from it.

    `sync(query)` runs once at subscribe time because the initialiser above
    and the query can disagree at mount: `window.innerWidth` is rounded, the
    media query is not (measured at `--force-device-scale-factor=1.1` on a
    1023px device: innerWidth 1024, `(min-width: 1024px)` false).
    `Sidebar.test.tsx` pins that case.

    Widening closes the sheet, so a later narrowing does not reopen it.
  */
  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT_PX}px)`)
    const sync = (e: MediaQueryListEvent | MediaQueryList) => {
      setIsDesktop(e.matches)
      if (e.matches) setMoreOpen(false)
    }
    sync(query)
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])

  // Any route change closes the sheet (#4053) — a back gesture or an in-page
  // link included. A tab tap also closes it directly (`more.onClose`), because
  // tapping the tab you are already on changes no route.
  useEffect(() => {
    setMoreOpen(false)
  }, [pathname])

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

  // The destinations the tab bar does NOT carry, in rail order, Settings last
  // (#4053). Derived from `TAB_ROUTES` itself — never a hand-copied list — so
  // a change to the bar cannot leave the sheet repeating a tab or dropping a
  // destination.
  const tabRoutes = new Set<string>(TAB_ROUTES)
  const sheetItems: NavItem[] = [
    ...navGroups.flatMap((group) => group.items).filter((item) => !tabRoutes.has(item.href)),
    { label: 'Settings', href: '/settings', icon: icons.settings },
  ]

  // The logo band, shared by the rail and the sheet. `gap-2` keeps the
  // environment badge off the wordmark (#4053 — it rendered "HavenDEV").
  // In the sheet the wordmark is not a link: Dashboard is a tab one cell
  // away, and the sheet carries no tab destination. And it is inset `px-6`
  // there, not the rail's `px-5`: the sheet's rows sit at `px-3` inside a
  // `px-3` column, so `px-6` puts the mark on the same left edge as the avatar
  // and the row icons (#4056 — it sat 4px outside them). The rail keeps `px-5`.
  const wordmarkClass = 'flex items-center gap-2 text-[15px] font-semibold tracking-tight text-[var(--v2-ink)]'
  const wordmark = (
    <>
      <HavenMark />
      <span className="v2-brand-gradient-text">Haven</span>
    </>
  )
  const logoBand = (linked: boolean) => (
    <div data-logo-band="" className={`h-14 flex items-center gap-2 ${linked ? 'px-5' : 'px-6'} flex-shrink-0`}>
      {linked ? (
        <Link href="/dashboard" className={wordmarkClass}>
          {wordmark}
        </Link>
      ) : (
        <span className={wordmarkClass}>{wordmark}</span>
      )}
      {/*
        The environment badge (#4029), beside the wordmark, in the rail and in
        the phone More sheet alike — the app's ONLY environment marker since
        the non-production warning line was removed. It renders nothing in
        production (`lib/env.ts`), so the band is byte-identical there.
        Outside the Link: a badge is not navigation, and it must not join the
        wordmark's click target.
      */}
      <EnvBadge />
    </div>
  )

  return (
    <>
      {/*
        Below `lg` the primary navigation is the tab bar (#2731), and its fifth
        cell, More, opens the sheet (#4053). The sheet replaced #2820's
        full-screen drawer — the desktop rail stretched to the screen, which
        covered the bar and left the More control floating over it as "Close"
        — and the rail itself no longer renders below `lg` at all.
      */}
      <MobileTabBar
        items={baseNavItems}
        more={{ open: sheetOpen, onToggle: () => setMoreOpen((v) => !v), onClose: closeMore, buttonRef: moreButtonRef }}
      />
      <MoreSheet
        open={sheetOpen}
        onClose={closeMore}
        items={sheetItems}
        isActive={(href) => isActiveRoute(pathname, href)}
        account={{ name, email: showEmailLine ? emailLine : null, initial: userInitial, active: profileActive }}
        onLogout={() => {
          setMoreOpen(false)
          logout()
          router.push('/')
        }}
        header={logoBand(false)}
        returnFocusRef={moreButtonRef}
      />

      {/*
        The desktop rail: a static 240px column inside the shell at `lg` and
        above, and `hidden` below it (#4053), where the tab bar and the sheet
        carry everything it holds. It stays in the DOM there rather than being
        JS-gated, so the `User menu` kebab the visual specs wait on as a
        "shell has mounted" signal is attached at every width. At `lg` the
        classes resolve exactly as before #4053.
      */}
      <aside
        className="hidden lg:flex lg:flex-col lg:translate-x-0 w-[240px] h-full z-[var(--v2-z-nav-drawer)] bg-[var(--v2-surface)] border-r border-[var(--v2-border)] flex-shrink-0"
      >
        {logoBand(true)}

        {/* Main nav — labeled clusters (#858, regrouped #3024) */}
        {/* Named because #2731 gave the shell a SECOND navigation. Two
            unnamed `<nav>` landmarks are ambiguous to a screen reader and to
            every `getByRole('navigation')` in the suite — `Sidebar.test.tsx`
            was reading `document.querySelector('nav')` and silently started
            measuring the tab bar instead of this rail. */}
        <nav
          aria-label="All sections"
          className="flex-1 px-3 py-4 overflow-y-auto"
        >
          {navGroups.map((group, groupIndex) => (
            <div key={group.label} className={groupIndex > 0 ? 'mt-5' : undefined}>
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
                    />
                  )
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Bottom section */}
        <div className="flex-shrink-0 border-t border-[var(--v2-border)]">
          {/* The quick theme toggle (#2928) — the rail's theme control, a
              full-width row like its neighbours. Below `lg` the rail is hidden
              and the More sheet carries the three-way control instead
              (#4053), so each width shows exactly one theme control. */}
          <div className="px-3 pt-2">
            <ThemeToggle />
          </div>
          {/* Settings */}
          <div className="px-3 py-2">
            <NavLink
              item={{ label: 'Settings', href: '/settings', icon: icons.settings }}
              active={pathname === '/settings'}
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
                aria-label={`Open profile for ${name}`}
                aria-current={profileActive ? 'page' : undefined}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2"
              >
                {/* Avatar */}
                <div className="w-8 h-8 rounded-full bg-[var(--v2-brand)] flex items-center justify-center text-xs font-bold text-[var(--v2-ink-on-brand)] flex-shrink-0">
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
                      onClick={() => setMenuOpen(false)}
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
                      onClick={() => setMenuOpen(false)}
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
