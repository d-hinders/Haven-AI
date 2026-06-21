'use client'

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
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

// Simple inline SVG icons
const icons = {
  dashboard: (
    <svg className="w-full h-full" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
    </svg>
  ),
  account: (
    <svg className="w-full h-full" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
    </svg>
  ),
  transactions: (
    <svg className="w-full h-full" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 7.5h11.25m0 0L15.75 4.5m3 3l-3 3M16.5 16.5H5.25m0 0l3-3m-3 3l3 3" />
    </svg>
  ),
  agents: (
    <svg className="w-full h-full" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <rect x="5" y="8" width="14" height="10" rx="3" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v3M9.5 12h.01M14.5 12h.01M9 16h6" />
    </svg>
  ),
  approvals: (
    <svg className="w-full h-full" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 01-1.043 3.296 3.745 3.745 0 01-3.296 1.043A3.745 3.745 0 0112 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 01-3.296-1.043 3.745 3.745 0 01-1.043-3.296A3.745 3.745 0 013 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 011.043-3.296 3.746 3.746 0 013.296-1.043A3.746 3.746 0 0112 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 013.296 1.043 3.746 3.746 0 011.043 3.296A3.745 3.745 0 0121 12z" />
    </svg>
  ),
  catalog: (
    <svg className="w-full h-full" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 21v-7.5a.75.75 0 01.75-.75h3a.75.75 0 01.75.75V21m-4.5 0H2.36m11.14 0H18m0 0h3.64m-1.39 0V9.349m-16.5 11.65V9.35m0 0a3.001 3.001 0 003.75-.615A2.993 2.993 0 009.75 9.75c.896 0 1.7-.393 2.25-1.016a2.993 2.993 0 002.25 1.016c.896 0 1.7-.393 2.25-1.016a3.001 3.001 0 003.75.614m-16.5 0a3.004 3.004 0 01-.621-4.72L4.318 3.44A1.5 1.5 0 015.378 3h13.243a1.5 1.5 0 011.06.44l1.19 1.189a3 3 0 01-.621 4.72m-13.5 8.65h3.75a.75.75 0 00.75-.75V13.5a.75.75 0 00-.75-.75H6.75a.75.75 0 00-.75.75v3.75c0 .415.336.75.75.75z" />
    </svg>
  ),
  contacts: (
    <svg className="w-full h-full" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
    </svg>
  ),
  profile: (
    <svg className="w-full h-full" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M17.982 18.725A7.488 7.488 0 0012 15.75a7.488 7.488 0 00-5.982 2.975M15 9.75a3 3 0 11-6 0 3 3 0 016 0zM21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  settings: (
    <svg className="w-full h-full" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
  logout: (
    <svg className="w-full h-full" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
    </svg>
  ),
  dotsVertical: (
    <svg className="w-full h-full" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="5" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="12" cy="19" r="1.5" />
    </svg>
  ),
  accounting: (
    <svg className="w-full h-full" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    </svg>
  ),
  custody: (
    <svg className="w-full h-full" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 01-1.043 3.296 3.745 3.745 0 01-3.296 1.043A3.745 3.745 0 0112 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 01-3.296-1.043 3.745 3.745 0 01-1.043-3.296A3.745 3.745 0 013 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 011.043-3.296 3.746 3.746 0 013.296-1.043A3.746 3.746 0 0112 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 013.296 1.043 3.746 3.746 0 011.043 3.296A3.745 3.745 0 0121 12z" />
    </svg>
  ),
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
        <span className="text-[10px] font-semibold leading-none px-1.5 py-0.5 rounded-full bg-[var(--v2-brand)] text-white v2-tabular">
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

  const mainNav: NavItem[] = [
    baseNavItems[0], // Dashboard
    baseNavItems[1], // Accounts
    baseNavItems[2], // Transactions
    baseNavItems[3], // Agents
    approvalsItem,   // Approvals (dynamic)
    baseNavItems[4], // Catalog
    baseNavItems[5], // Contacts
    baseNavItems[6], // Accounting
    baseNavItems[7], // Custody
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
        className="lg:hidden fixed top-4 left-4 z-[60] w-8 h-8 flex items-center justify-center rounded-md bg-[var(--v2-bg)] border border-[var(--v2-border)] text-[var(--v2-ink-2)] shadow-[var(--v2-shadow-card)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
        </svg>
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

        {/* Main nav */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {mainNav.map((item) => {
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
                className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30 focus-visible:ring-offset-1"
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
                    className="w-7 h-7 flex items-center justify-center rounded-md text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)] focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30 focus-visible:outline-none transition-colors"
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
