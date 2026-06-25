'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import ApprovalNotifications from './ApprovalNotifications'
import WalletButton from './WalletButton'
import EnvBadge from './EnvBadge'

interface TopBarProps {
  actionSlot?: React.ReactNode
}

interface BackLink {
  href: string
  label: string
}

function resolveBackLink(pathname: string): BackLink | null {
  // Only show on detail routes — never on hub pages
  if (/^\/agents\/[^/]+/.test(pathname)) {
    return { href: '/agents', label: 'Agents' }
  }
  if (/^\/accounts\/[^/]+/.test(pathname)) {
    return { href: '/accounts', label: 'Accounts' }
  }
  return null
}

export default function TopBar({ actionSlot }: TopBarProps) {
  const pathname = usePathname()
  const back = resolveBackLink(pathname)

  return (
    <header className="relative z-[100] h-14 flex items-center px-6 lg:px-8 border-b border-[var(--v2-border)] bg-[var(--v2-bg)]/85 backdrop-blur-md flex-shrink-0">
      {/* Left region: hamburger spacer + optional back-link */}
      <div className="flex items-center gap-3 min-w-0">
        {/* Spacer for mobile hamburger */}
        <div className="w-8 lg:hidden" />
        <EnvBadge />
        {back && (
          <Link
            href={back.href}
            className="group inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)] transition-colors"
          >
            <svg
              aria-hidden="true"
              className="w-3.5 h-3.5 text-[var(--v2-ink-3)] group-hover:text-[var(--v2-ink-2)] transition-colors"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10 12.5L5.5 8L10 3.5" />
            </svg>
            <span>{back.label}</span>
          </Link>
        )}
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
