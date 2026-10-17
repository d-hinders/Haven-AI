'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import Link from 'next/link'
import { LogOut } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { SegmentedControl } from '@haven_ai/ui/SegmentedControl'
import { useTheme, type ThemePreference } from '@/context/ThemeContext'
import { useT } from '@/context/LocaleContext'
import type { NavItem } from './Sidebar'

/**
 * Distance, in CSS pixels, a downward drag on the handle has to travel before
 * release dismisses the sheet. Below it the sheet returns to rest. A quarter of
 * the tab bar's 56px row would trigger on a tap that wobbles; 80 is a gesture.
 */
export const SWIPE_DISMISS_PX = 80

/**
 * The phone "More" menu (#4053): a bottom sheet over a still-visible tab bar.
 *
 * It replaced #2820's full-screen drawer, which was the desktop rail stretched
 * to the screen — it covered the tab bar, so the bar's More control floated
 * alone over it as "Close", and the footer kept a 20% strip clear of that
 * control. Stopping the sheet ABOVE the bar removes both at once.
 *
 * ## Geometry, not tiers, keeps the tab bar reachable
 *
 * The sheet and its scrim both end at `--v2-tab-bar-h + --v2-safe-bottom +
 * 1px` (the bar's border) from the bottom of the viewport — exactly the bar's
 * top edge. They sit on the nav tiers above the bar, but they never overlap
 * it, so the bar stays
 * painted and tappable without any tier change.
 *
 * The scrim's TOP stops at `--v2-safe-top`, deliberately unlike a modal
 * backdrop (which dims to `y=0`): the status-bar band stays the shell's
 * opaque `SafeAreaBand` and nothing translucent ever enters it. #2819 is the
 * reason — on an installed iPhone the band kept the old nav scrim's grey
 * after the drawer closed, and #2820 settled it by keeping the navigation's
 * cover of that strip opaque. Outside an installed app the inset is 0 and the
 * scrim reaches the top like any backdrop. It is `.v2-modal-backdrop`, so no
 * `backdrop-filter` either.
 *
 * ## Non-modal, on purpose
 *
 * `role="dialog"` without `aria-modal`: the tab bar beneath stays live, so
 * the rest of the page is not inert and claiming it is would be false. Focus
 * moves into the sheet on open and returns to the More control when the sheet
 * is dismissed (`returnFocusRef`). No scroll lock: the page scrolls inside `<main>`, and
 * the scrim is not a descendant of it, so a drag on the scrim scrolls nothing.
 *
 * ## The harness reads `data-more-sheet`
 *
 * The sheet only exists while open, so "open" is `[data-more-sheet]` attached
 * and "closed" is it absent — `dismissMobileSidebar` and `waitForDrawerOpen`
 * in `e2e/fixtures/haven-api.ts` key on that, and `data-state="open"` is the
 * settled-after-animation signal they wait for.
 */
export function MoreSheet({
  open,
  onClose,
  items,
  isActive,
  account,
  onLogout,
  header,
  returnFocusRef,
}: {
  open: boolean
  onClose: () => void
  /** Destinations the tab bar does NOT carry, in rail order, Settings last. */
  items: NavItem[]
  isActive: (href: string) => boolean
  account: { name: string; email: string | null; initial: string; active: boolean }
  onLogout: () => void
  /** The logo band (wordmark + environment badge), shared with the rail. */
  header: React.ReactNode
  returnFocusRef: RefObject<HTMLElement | null>
}) {
  const t = useT()
  const { preference, setPreference } = useTheme()
  const sheetRef = useRef<HTMLDivElement>(null)
  const dragStart = useRef<number | null>(null)
  const [dragY, setDragY] = useState(0)
  const [settled, setSettled] = useState(false)

  // Focus moves in on open.
  useEffect(() => {
    if (!open) return
    sheetRef.current?.querySelector<HTMLElement>('a[href], button')?.focus({ preventScroll: true })
  }, [open])

  // A DISMISSAL (Escape, scrim, swipe) hands focus back to the More control.
  // Navigating away does not: a destination link or a tab tap closes the
  // sheet too, and pulling focus back onto More after a route change would
  // be wrong. The More control itself already holds focus when it closes.
  const dismiss = useRef(() => {})
  dismiss.current = () => {
    onClose()
    returnFocusRef.current?.focus({ preventScroll: true })
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        dismiss.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  useEffect(() => {
    if (!open) {
      setSettled(false)
      setDragY(0)
      return
    }
    // Settled = the enter animation has finished (`onAnimationEnd` below).
    // Under reduced motion there is no animation and no end event, so the
    // next frame is already the final position.
    // The timeout is the backstop for an end event that never comes (a
    // background tab does not run animations): 200ms of animation, doubled.
    const reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : true
    const id = window.requestAnimationFrame(() => {
      if (reduce) setSettled(true)
    })
    const backstop = window.setTimeout(() => setSettled(true), 400)
    return () => {
      window.cancelAnimationFrame(id)
      window.clearTimeout(backstop)
    }
  }, [open])

  if (!open) return null

  const onPointerDown = (e: React.PointerEvent) => {
    dragStart.current = e.clientY
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragStart.current === null) return
    setDragY(Math.max(0, e.clientY - dragStart.current))
  }
  const onPointerEnd = (e: React.PointerEvent) => {
    if (dragStart.current === null) return
    const travelled = e.clientY - dragStart.current
    dragStart.current = null
    setDragY(0)
    if (travelled >= SWIPE_DISMISS_PX) dismiss.current()
  }

  // The bar's top edge: its cells are `--v2-tab-bar-h` tall, it pads the
  // home-indicator inset below them, and it draws a 1px `border-t` above them.
  // Without the 1px the sheet would sit on the bar's border line.
  const bottom = 'bottom-[calc(var(--v2-tab-bar-h)+var(--v2-safe-bottom)+1px)]'

  return (
    <>
      <div
        aria-hidden="true"
        data-more-sheet-scrim=""
        onClick={() => dismiss.current()}
        className={`lg:hidden fixed inset-x-0 top-[var(--v2-safe-top)] ${bottom} z-[var(--v2-z-nav-scrim)] v2-modal-backdrop`}
      />
      <div
        ref={sheetRef}
        id="more-sheet"
        role="dialog"
        aria-label="More"
        data-more-sheet=""
        data-state={settled ? 'open' : 'opening'}
        onAnimationEnd={(e) => {
          if (e.target === e.currentTarget) setSettled(true)
        }}
        style={dragY ? { transform: `translateY(${dragY}px)` } : undefined}
        className={`lg:hidden fixed inset-x-0 ${bottom} z-[var(--v2-z-nav-drawer)] flex max-h-[calc(100dvh-var(--v2-tab-bar-h)-var(--v2-safe-bottom)-var(--v2-safe-top)-1rem)] flex-col rounded-t-xl border-x border-t border-[var(--v2-border)] bg-[var(--v2-surface)] pl-[var(--v2-safe-left)] pr-[var(--v2-safe-right)] shadow-popover v2-sheet-enter`}
      >
        {/* The drag handle. A pointer target in its own right — the list
            below scrolls, and a swipe that started there must scroll it, not
            dismiss the sheet — so only a drag that STARTS on the handle
            counts. `touch-none` keeps the browser from claiming the gesture
            as a page scroll first. */}
        <div
          data-more-sheet-handle=""
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          className="flex h-6 flex-shrink-0 touch-none items-center justify-center"
        >
          <span aria-hidden="true" className="h-1 w-9 rounded-full bg-[var(--v2-border-strong)]" />
        </div>

        {header}

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {/* Account first: who you are, then where you can go. The whole
              row is the profile link — one target, the name it was always
              announced by (`Open profile for …`). */}
          <Link
            href="/profile"
            onClick={onClose}
            aria-label={`Open profile for ${account.name}`}
            aria-current={account.active ? 'page' : undefined}
            className={`flex items-center gap-3 rounded-md px-3 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 ${
              account.active ? 'bg-[var(--v2-brand-soft)]' : 'hover:bg-[var(--v2-surface-2)]'
            }`}
          >
            <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--v2-brand)] text-xs font-bold text-[var(--v2-ink-on-brand)]">
              {account.initial}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium leading-tight text-[var(--v2-ink)]">{account.name}</span>
              {account.email && (
                <span className="mt-0.5 block truncate text-xs leading-tight text-[var(--v2-ink-3)]">{account.email}</span>
              )}
            </span>
          </Link>

          <nav aria-label="All sections" className="mt-2 border-t border-[var(--v2-border)] pt-2">
            <ul className="space-y-0.5">
              {items.map((item) => {
                const active = isActive(item.href)
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onClose}
                      aria-current={active ? 'page' : undefined}
                      className={`flex h-11 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 ${
                        active
                          ? 'bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]'
                          : 'text-[var(--v2-ink-2)] hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)]'
                      }`}
                    >
                      <span className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center">{item.icon}</span>
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.attention && (
                        <span
                          data-testid={`nav-attention${item.href.replace(/\//g, '-')}`}
                          className="inline-flex h-2 w-2 flex-shrink-0 rounded-full bg-[var(--v2-warning)]"
                        >
                          <span className="sr-only"> {item.attention}</span>
                        </span>
                      )}
                      {item.badge && (
                        <span
                          className={`flex-shrink-0 whitespace-nowrap rounded-full px-1.5 py-0.5 text-xs font-semibold leading-none v2-tabular ${
                            item.badgeTone === 'muted'
                              ? 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-3)]'
                              : 'bg-[var(--v2-brand)] text-[var(--v2-ink-on-brand)]'
                          }`}
                        >
                          <span aria-hidden="true">{item.badgeTitle ?? item.badge}</span>
                          {/* Leading space: the name reads "Accounting Coming soon", never run together. */}
                          <span className="sr-only"> {item.badgeTitle ?? item.badge}</span>
                        </span>
                      )}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </nav>

          {/* Theme: the full three-way choice (owner decision 2026-10-17 on
              #4053), superseding #2953's two-state flip for this sheet only —
              the desktop rail keeps the flip. Same preference, same setter
              Settings → Theme writes, so the two can never disagree. */}
          <div className="mt-2 flex items-center justify-between gap-3 border-t border-[var(--v2-border)] px-3 pt-3">
            <span className="text-sm font-medium text-[var(--v2-ink-2)]">{t.settings.theme.label}</span>
            <SegmentedControl
              ariaLabel={t.settings.theme.label}
              value={preference}
              onChange={(next: ThemePreference) => setPreference(next)}
              options={[
                { value: 'light', label: t.settings.theme.light },
                { value: 'dark', label: t.settings.theme.dark },
                { value: 'system', label: t.settings.theme.system },
              ]}
            />
          </div>

          <button
            type="button"
            onClick={onLogout}
            className="mt-3 flex h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium text-[var(--v2-danger)] transition-colors hover:bg-[var(--v2-danger-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/80"
          >
            <span className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center">
              <Icon icon={LogOut} className="h-full w-full" />
            </span>
            Log out
          </button>
        </div>
      </div>
    </>
  )
}
