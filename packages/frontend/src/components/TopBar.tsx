'use client'

import { usePathname } from 'next/navigation'
import ApprovalNotifications from './ApprovalNotifications'
import WalletButton from './WalletButton'

interface TopBarProps {
  title?: string
  actionSlot?: React.ReactNode
}

function resolvePageLabel(pathname: string, fallbackTitle?: string): string {
  if (pathname === '/dashboard') return 'Dashboard'
  if (pathname === '/accounts') return 'Accounts'
  if (pathname.startsWith('/accounts/')) return 'Account detail'
  if (pathname === '/transactions') return 'Transactions'
  if (pathname === '/agents') return 'Agents'
  if (pathname.startsWith('/agents/')) return 'Agent detail'
  if (pathname === '/approvals') return 'Approvals'
  if (pathname === '/contacts') return 'Contacts'
  if (pathname === '/settings') return 'Settings'
  return fallbackTitle ?? ''
}

export default function TopBar({ title, actionSlot }: TopBarProps) {
  const pathname = usePathname()
  const page = resolvePageLabel(pathname, title)

  return (
    <header className="relative z-[100] h-14 flex items-center px-6 lg:px-8 border-b border-[var(--v2-border)] bg-[var(--v2-bg)]/85 backdrop-blur-md flex-shrink-0">
      {/* Left region: hamburger spacer + page title */}
      <div className="flex items-center gap-3 min-w-0">
        {/* Spacer for mobile hamburger */}
        <div className="w-8 lg:hidden" />
        {page && (
          <h1 className="text-[14px] font-medium text-[var(--v2-ink)] truncate">
            {page}
          </h1>
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
