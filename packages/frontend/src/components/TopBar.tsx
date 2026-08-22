'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import ApprovalNotifications from './ApprovalNotifications'
import WalletButton from './WalletButton'
import EnvBadge from './EnvBadge'
import NetworkSwitcher from './NetworkSwitcher'
import { ChevronLeft } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'

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
    // z-[var(--v2-z-chrome)]: the app chrome tier. Deliberately BELOW the
    // mobile navigation tiers — the sidebar's toggle is positioned inside this
    // bar's own band (see the `w-8 lg:hidden` spacer below, which reserves the
    // room for it), so a bar that outranks the toggle covers the control it is
    // making space for. That was #1749.
    <header className="relative z-[var(--v2-z-chrome)] h-14 flex items-center px-6 lg:px-8 border-b border-[var(--v2-border)] bg-[var(--v2-surface-2)] backdrop-blur-md flex-shrink-0">
      {/*
        Left region: hamburger spacer + optional back-link.

        `mr-3` is a floor, not decoration (#1767, design review). This region is
        the compressible one and the right region carries `ml-auto`, so on a
        phone the two meet exactly when the row runs out of space: measured at
        390px, the account chip's right edge landed on the notification bell's
        left edge at 210.61 — touching, with no overlap and no gap either. That
        was a coincidence of the current strings, not a spacing decision, and it
        sat one line away from this file rejecting a 6px gap elsewhere as too
        tight. `mr-3` gives it the same 12px the row uses between its own items;
        where there is free space `ml-auto` absorbs it and nothing moves.
      */}
      <div className="flex items-center gap-3 min-w-0 mr-3">
        {/*
          Spacer for the mobile hamburger. The toggle is `fixed` (#1749) so it
          consumes no layout at all — this box is the ONLY thing keeping the
          bar's own content out from under it, and it is therefore load-bearing
          rather than cosmetic.

          `shrink-0` is the load-bearing half (#1767). A bare `w-8` is a flex
          item with the default `flex-shrink: 1`, and this row is
          over-subscribed on a phone: at 390px the spacer was the only
          compressible item, so it collapsed to width 0 and the toggle painted
          straight over `NetworkSwitcher` — measured, the toggle's 44px hit
          area (#1766) swallowed the chip's leading 18px of tap area. The bar
          reserved the room at 768px and up, where nothing needed reserving,
          and gave it away on every real phone.

          The 32px it stops giving away has to come from somewhere in an
          over-subscribed row: it comes out of `NetworkSwitcher`, which is the
          widest item here and the only one that can truncate. See the note on
          its root `min-w-0`. `e2e/mobile-nav-tap-target.mobile.spec.ts`
          asserts this box's MEASURED width, not its class.
        */}
        <div className="w-8 shrink-0 lg:hidden" />
        <EnvBadge />
        <NetworkSwitcher />
        {back && (
          <Link
            href={back.href}
            className="group inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)] transition-colors"
          >
            <Icon
              icon={ChevronLeft}
              className="w-3.5 h-3.5 text-[var(--v2-ink-3)] group-hover:text-[var(--v2-ink-2)] transition-colors"
            />
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
