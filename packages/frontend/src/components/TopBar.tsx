'use client'

import WalletButton from './WalletButton'

interface TopBarProps {
  title?: string
}

export default function TopBar({ title }: TopBarProps) {
  return (
    <header className="h-14 flex items-center justify-between px-6 lg:px-8 border-b border-white/[0.06] bg-[#0a0a0a]/60 backdrop-blur-md flex-shrink-0">
      <div className="flex items-center gap-3">
        {/* Spacer for mobile hamburger */}
        <div className="w-8 lg:hidden" />
        {title && (
          <h1 className="text-sm font-medium text-zinc-400">{title}</h1>
        )}
      </div>
      <WalletButton />
    </header>
  )
}
