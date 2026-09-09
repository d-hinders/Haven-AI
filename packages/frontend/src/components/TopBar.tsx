'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
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
    //
    // bg-bg/85, not bg-[var(--v2-bg)]/85 (#1818). The arbitrary-value form put an
    // opacity modifier on a bare var(), which Tailwind v3.4 drops silently — this
    // bar had NO background rule at all, and `backdrop-blur-md` had nothing to
    // composite. It looked fine only because --v2-bg is white and the page behind
    // it is the same white. `bg-bg` reads the channel token --v2-bg-rgb through
    // <alpha-value>, so the modifier compiles. See tailwind.config.js's colours.
    // Safe-area insets (#2730). Below `lg` only, and all three arithmetic
    // forms collapse to the previous value when the insets are 0 — the bar
    // GROWS by the top inset rather than padding its content into the same
    // 56px, so the status bar sits over the bar's own background instead of
    // over the first row of controls; the horizontal pair keep the `px-6`
    // gutter and only widen it on a landscape phone, where the notch eats one
    // side. `lg:` is untouched, so the desktop render is byte-identical.
    <header className="relative z-[var(--v2-z-chrome)] h-14 max-lg:h-[calc(3.5rem+var(--v2-safe-top))] max-lg:pt-[var(--v2-safe-top)] flex items-center px-6 lg:px-8 max-lg:pl-[max(1.5rem,var(--v2-safe-left))] max-lg:pr-[max(1.5rem,var(--v2-safe-right))] border-b border-[var(--v2-border)] bg-bg/85 backdrop-blur-md flex-shrink-0">
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

      {/* Right region: wallet. The approval-notification bell was deleted with
          the legacy Safe rail (#1989, epic #1440) — the delegation rail enforces
          budgets on-chain and produces no approvals to notify about. */}
      <div className="ml-auto flex items-center gap-3">
        <WalletButton />
      </div>
    </header>
  )
}
