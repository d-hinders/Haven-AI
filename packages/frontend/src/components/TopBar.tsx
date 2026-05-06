'use client'

import ApprovalNotifications from './ApprovalNotifications'
import WalletButton from './WalletButton'

interface TopBarProps {
  title?: string
}

export default function TopBar({ title }: TopBarProps) {
  return (
    <header className="relative z-[100] h-14 flex items-center justify-between px-6 lg:px-8 border-b border-[var(--v2-border)] bg-[var(--v2-bg)]/85 backdrop-blur-md flex-shrink-0">
      <div className="flex items-center gap-3">
        {/* Spacer for mobile hamburger */}
        <div className="w-8 lg:hidden" />
        {title && (
          <h1 className="text-sm font-medium text-[var(--v2-ink-2)]">{title}</h1>
        )}
      </div>
      <div className="flex items-center gap-3">
        <ApprovalNotifications />
        <WalletButton />
      </div>
    </header>
  )
}
