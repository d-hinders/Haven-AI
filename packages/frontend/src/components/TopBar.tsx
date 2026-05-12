'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import ApprovalNotifications from './ApprovalNotifications'
import WalletButton from './WalletButton'

interface TopBarProps {
  title?: string
  actionSlot?: React.ReactNode
}

interface BreadcrumbInfo {
  section: string | null
  sectionHref: string
  page: string
}

const SECTION_HUBS = {
  Wallet: '/dashboard',
  Automation: '/agents',
  Workspace: '/contacts',
} as const

function resolveBreadcrumb(pathname: string, fallbackTitle?: string): BreadcrumbInfo {
  if (pathname === '/dashboard') {
    return { section: 'Wallet', sectionHref: SECTION_HUBS.Wallet, page: 'Dashboard' }
  }
  if (pathname === '/accounts') {
    return { section: 'Wallet', sectionHref: SECTION_HUBS.Wallet, page: 'Accounts' }
  }
  if (pathname.startsWith('/accounts/')) {
    return { section: 'Wallet', sectionHref: SECTION_HUBS.Wallet, page: 'Account detail' }
  }
  if (pathname === '/transactions') {
    return { section: 'Wallet', sectionHref: SECTION_HUBS.Wallet, page: 'Transactions' }
  }
  if (pathname === '/agents') {
    return { section: 'Automation', sectionHref: SECTION_HUBS.Automation, page: 'Agents' }
  }
  if (pathname.startsWith('/agents/')) {
    return { section: 'Automation', sectionHref: SECTION_HUBS.Automation, page: 'Agent detail' }
  }
  if (pathname === '/approvals') {
    return { section: 'Automation', sectionHref: SECTION_HUBS.Automation, page: 'Approvals' }
  }
  if (pathname === '/contacts') {
    return { section: 'Workspace', sectionHref: SECTION_HUBS.Workspace, page: 'Contacts' }
  }
  if (pathname === '/settings') {
    return { section: 'Workspace', sectionHref: SECTION_HUBS.Workspace, page: 'Settings' }
  }
  return { section: null, sectionHref: '/', page: fallbackTitle ?? '' }
}

export default function TopBar({ title, actionSlot }: TopBarProps) {
  const pathname = usePathname()
  const { section, sectionHref, page } = resolveBreadcrumb(pathname, title)
  const sectionIsCurrent = section !== null && sectionHref === pathname

  return (
    <header className="relative z-[100] h-14 flex items-center px-6 lg:px-8 border-b border-[var(--v2-border)] bg-[var(--v2-bg)]/85 backdrop-blur-md flex-shrink-0">
      {/* Left region: hamburger spacer + breadcrumb */}
      <div className="flex items-center gap-3 min-w-0">
        {/* Spacer for mobile hamburger */}
        <div className="w-8 lg:hidden" />
        <nav aria-label="Breadcrumb" className="flex items-center gap-2 min-w-0">
          {section !== null && (
            sectionIsCurrent ? (
              <span className="text-[13px] text-[var(--v2-ink-3)] whitespace-nowrap">
                {section}
              </span>
            ) : (
              <Link
                href={sectionHref}
                className="text-[13px] text-[var(--v2-ink-3)] hover:text-[var(--v2-ink-2)] transition-colors whitespace-nowrap"
              >
                {section}
              </Link>
            )
          )}
          {section !== null && (
            <span aria-hidden="true" className="text-[var(--v2-ink-3)]/60 text-[13px]">
              ·
            </span>
          )}
          <span className="text-[14px] font-medium text-[var(--v2-ink)] truncate">
            {page}
          </span>
        </nav>
      </div>

      {/* Center / action slot */}
      {actionSlot ? (
        <div className="hidden md:flex items-center ml-4">
          {actionSlot}
        </div>
      ) : null}

      {/* Right region: notifications + wallet */}
      <div className="ml-auto flex items-center gap-3">
        <ApprovalNotifications />
        <WalletButton />
      </div>
    </header>
  )
}
