'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import WalletButton from './WalletButton'
import EnvBadge from './EnvBadge'
import NetworkSwitcher from './NetworkSwitcher'
import { ChevronLeft } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { SafeAreaBand } from '@/components/ui/SafeAreaBand'

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
    // mobile navigation tiers, so a bar that outranks the drawer covers the
    // control it makes space for. That was #1749. (The `w-8 lg:hidden` spacer
    // that reservation used to refer to is GONE — #2731 moved the toggle out of
    // this bar entirely and into the tab bar's More slot; see the note further
    // down.)
    //
    // bg-bg/85, not bg-[var(--v2-bg)]/85 (#1818). The arbitrary-value form put an
    // opacity modifier on a bare var(), which Tailwind v3.4 drops silently — this
    // bar had NO background rule at all, and `backdrop-blur-md` had nothing to
    // composite. It looked fine only because --v2-bg is white and the page behind
    // it is the same white. `bg-bg` reads the channel token --v2-bg-rgb through
    // <alpha-value>, so the modifier compiles. See tailwind.config.js's colours.
    //
    // Safe-area insets (#2730, restructured by #2819). The horizontal pair keep
    // the `px-6` gutter and only widen it on a landscape phone, where the notch
    // eats one side; both collapse to the previous value at zero insets, and
    // `lg:` is untouched, so the desktop render is byte-identical. The TOP inset
    // is no longer padding on this bar — it is the `SafeAreaBand` above it, for
    // the reason that component's docstring gives.
    <header
      data-app-chrome=""
      className="relative z-[var(--v2-z-chrome)] flex-shrink-0"
    >
      {/*
        The status-bar band is its own OPAQUE, unblurred element (#2819).

        #2730 originally grew the header itself by `--v2-safe-top`, which put the
        status-bar band inside an element carrying `backdrop-blur-md`. On the
        installed iOS shell that band was observed keeping the nav scrim's grey
        after the drawer closed, while the header's own hairline below it drew
        correctly.

        The mechanism is a hypothesis and the issue records it as one: NOT a
        stale backdrop sample — the scrim is `--v2-z-nav-scrim` (130) against
        this bar's `--v2-z-chrome` (100), so it paints in FRONT and was never in
        this element's backdrop — but the composited output of the
        `backdrop-filter` layer failing to invalidate when the overlay above it
        unmounts, which iOS WebKit has a long history of. Nothing runnable here
        can reproduce it: the symptom needs a standalone shell with non-zero
        insets, and no engine in CI has either.

        So this removes the CLASS rather than betting on the instance. No
        `backdrop-filter` layer spans the status bar any more, so nothing there
        can hold a stale composite whatever the precise mechanism. It is also
        the better rendering on its own terms — the band behind a status bar
        wants to be opaque, not a translucent blur of whatever is beneath.

        `--v2-safe-top` is 0 everywhere without a notch, so this element
        collapses to zero height and the desktop and CI renders are unchanged.

        `<header>` stays the OUTERMOST element rather than the inner bar, and
        that is load-bearing rather than taste: `design-system.visual.spec.ts`
        locates the top bar structurally, as
        `//*[@id="main-content"]/preceding-sibling::header[1]`, deliberately
        (#1820). Nesting the `<header>` inside a wrapper makes that xpath match
        nothing, and the visual gate would fail on a locator rather than on a
        pixel — a failure this diff would have shipped, because `*.visual.spec.ts`
        was excluded from the local gate until #2827; `test:e2e:gate:built`
        now runs these specs for their locators. It also
        reads better as semantics: the banner landmark is the whole chrome band,
        including the part behind the status bar.
      */}
      <SafeAreaBand />
      <div
        data-app-bar=""
        className="h-14 flex items-center px-6 lg:px-8 max-lg:pl-[max(1.5rem,var(--v2-safe-left))] max-lg:pr-[max(1.5rem,var(--v2-safe-right))] border-b border-[var(--v2-border)] bg-bg/85 backdrop-blur-md"
      >
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
            The mobile hamburger's spacer is GONE (#2731), and its absence is the
            point: the toggle moved out of this bar's band entirely and became
            the tab bar's "More" slot at the bottom of the screen, so there is no
            longer a fixed control overlapping this row to reserve room for.

            What that gives back is 32px on a phone, and it goes where it was
            taken from — `NetworkSwitcher`, the widest item here and the only one
            that could truncate to pay for the spacer (#1767). If a fixed control
            is ever reintroduced over this row, the reservation has to come back
            with it; a bare `w-8` is not enough, it needs `shrink-0`, because this
            row is over-subscribed at 390px and an unshrunk spacer collapses to
            zero and lets the control paint over the chip.
          */}
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

        {/* Right region: wallet. The approval-notification bell was deleted
            with the legacy Safe rail (#1989, epic #1440) — the delegation rail
            enforces budgets on-chain and produces no approvals to notify
            about. */}
        <div className="ml-auto flex items-center gap-3">
          <WalletButton />
        </div>
      </div>
    </header>
  )
}
