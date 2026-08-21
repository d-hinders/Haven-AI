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
  Settings,
  ShieldCheck,
  Store,
  Users,
} from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useAuth } from '@/context/AuthContext'
import { displayName, userInitial as getUserInitial } from '@/lib/user'
import { HavenMark } from '@/components/brand/HavenMark'
import { useApprovals } from '@/hooks/useApprovals'
import { Tooltip } from '@/components/ui/Tooltip'

interface NavItem {
  label: string
  href: string
  icon: React.ReactNode
  badge?: string
}

// Lucide icons via the shared Icon convention (w/h-full fills the nav slot).
const icons = {
  dashboard: <Icon icon={LayoutGrid} className="w-full h-full" />,
  account: <Icon icon={ShieldCheck} className="w-full h-full" />,
  transactions: <Icon icon={ArrowLeftRight} className="w-full h-full" />,
  agents: <Icon icon={Bot} className="w-full h-full" />,
  approvals: <Icon icon={BadgeCheck} className="w-full h-full" />,
  catalog: <Icon icon={Store} className="w-full h-full" />,
  contacts: <Icon icon={Users} className="w-full h-full" />,
  profile: <Icon icon={CircleUserRound} className="w-full h-full" />,
  settings: <Icon icon={Settings} className="w-full h-full" />,
  logout: <Icon icon={LogOut} className="w-full h-full" />,
  dotsVertical: <Icon icon={EllipsisVertical} className="w-full h-full" />,
  accounting: <Icon icon={FileText} className="w-full h-full" />,
  custody: <Icon icon={BadgeCheck} className="w-full h-full" />,
}

const baseNavItems: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: icons.dashboard },
  { label: 'Accounts', href: '/accounts', icon: icons.account },
  { label: 'Transactions', href: '/transactions', icon: icons.transactions },
  { label: 'Agents', href: '/agents', icon: icons.agents },
  // Approvals is injected dynamically with live badge
  { label: 'Catalog', href: '/catalog', icon: icons.catalog },
  { label: 'Contacts', href: '/contacts', icon: icons.contacts },
  { label: 'Reporting', href: '/reporting', icon: icons.accounting },
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
      <span className="flex-1">{item.label}</span>
      {item.badge && (
        <span className="text-xs font-semibold leading-none px-1.5 py-0.5 rounded-full bg-[var(--v2-brand)] text-white v2-tabular">
          {item.badge}
        </span>
      )}
    </Link>
  )
}

export default function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const { user, logout } = useAuth()
  const [collapsed, setCollapsed] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < DESKTOP_BREAKPOINT_PX,
  )
  const [menuOpen, setMenuOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  const { actionableCount } = useApprovals()

  const name = displayName(user)
  const userInitial = getUserInitial(user)
  const emailLine = user?.email ?? ''
  // Avoid showing the same value twice — if displayName resolves to email, hide the second line
  const showEmailLine = emailLine !== '' && name !== emailLine
  const profileActive = pathname === '/profile'

  // Build nav items — inject Approvals (with live badge) between Agents and Contacts
  const approvalsItem: NavItem = {
    label: 'Approvals',
    href: '/approvals',
    icon: icons.approvals,
    ...(actionableCount > 0
      ? { badge: actionableCount > 99 ? '99+' : String(actionableCount) }
      : {}),
  }

  // #1079: the approval queue is a legacy-rail (AllowanceModule) concept — the
  // delegation rail enforces budgets on-chain with no queue. A user whose
  // accounts are ALL delegation accounts never has approvals, so the entry
  // point is hidden. Any Safe-rail account keeps it (mixed users included).
  const onlyDelegationAccounts =
    (user?.safes?.length ?? 0) > 0 &&
    (user?.safes ?? []).every((safe) => safe.account_type === 'delegator_hybrid')

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
        ...(onlyDelegationAccounts ? [] : [approvalsItem]), // Approvals (dynamic badge)
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
        baseNavItems[6], // Reporting
        baseNavItems[7], // Custody
      ],
    },
  ]

  // Outside-click to close kebab popover
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
      {/* Mobile toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        aria-label={collapsed ? 'Open sidebar' : 'Close sidebar'}
        className="lg:hidden fixed top-4 left-4 z-[60] w-8 h-8 flex items-center justify-center rounded-md bg-[var(--v2-bg)] border border-[var(--v2-border)] text-[var(--v2-ink-2)] shadow-[var(--v2-shadow-card)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
      >
        <Icon icon={Menu} className="w-4 h-4" />
      </button>

      {/* Overlay for mobile */}
      {!collapsed && (
        <div
          className="lg:hidden fixed inset-0 bg-[var(--v2-ink)]/40 backdrop-blur-sm z-40"
          onClick={() => setCollapsed(true)}
        />
      )}

      <aside
        className={`fixed lg:static inset-y-0 left-0 z-50 w-[240px] h-screen lg:h-full bg-[var(--v2-surface)] border-r border-[var(--v2-border)] flex flex-col flex-shrink-0 transition-transform duration-200 ${
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
        <nav className="flex-1 px-3 py-4 overflow-y-auto">
          {navGroups.map((group, groupIndex) => (
            <div key={group.label} className={groupIndex > 0 ? 'mt-5' : ''}>
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
        <div className="flex-shrink-0 border-t border-[var(--v2-border)]">
          {/* Settings */}
          <div className="px-3 py-2">
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
                className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-offset-1"
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
                    className="w-7 h-7 flex items-center justify-center rounded-md text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)] focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:outline-none transition-colors"
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
                    className="absolute bottom-full right-0 mb-2 w-44 bg-[var(--v2-bg)] border border-[var(--v2-border)] rounded-lg shadow-[var(--v2-shadow-popover)] py-1 z-[60]"
                  >
                    <Link
                      href="/profile"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false)
                        setCollapsed(true)
                      }}
                      className="flex items-center gap-2 px-3 py-2 text-[13px] text-[var(--v2-ink)] hover:bg-[var(--v2-surface)] w-full text-left transition-colors"
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
                      className="flex items-center gap-2 px-3 py-2 text-[13px] text-[var(--v2-ink)] hover:bg-[var(--v2-surface)] w-full text-left transition-colors"
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
                      className="flex items-center gap-2 px-3 py-2 text-[13px] text-[var(--v2-danger)] hover:bg-[var(--v2-danger-soft)] w-full text-left transition-colors"
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
