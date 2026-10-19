'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import Link from 'next/link'
import { ChevronRight, LogOut, X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { SegmentedControl } from '@haven_ai/ui/SegmentedControl'
import { useTheme, type ThemePreference } from '@/context/ThemeContext'
import { useT } from '@/context/LocaleContext'
import type { NavItem } from './Sidebar'

/**
 * Distance, in CSS pixels, a downward drag on the handle has to travel before
 * release dismisses the sheet. Below it the sheet returns to rest. A quarter of
 * a 56px row would trigger on a tap that wobbles; 80 is a gesture.
 */
export const SWIPE_DISMISS_PX = 80

/**
 * The phone "More" menu (#4053): a floating card over the floating tab bar
 * (#4058).
 *
 * It replaced #2820's full-screen drawer, which was the desktop rail stretched
 * to the screen. #4053 first made it a bottom sheet that STOPPED at the bar's
 * top edge so the bar stayed live beneath it; once the bar became a floating
 * pill (#4058) that edge cut straight through the pill and left the strip
 * around it undimmed, so the sheet now floats over the bar instead, the way
 * native sheets float over a tab bar.
 *
 * ## Geometry: covered by rank, shaded edge to edge
 *
 * The card floats 8px in from the sides and the bottom (or the safe-area
 * inset, whichever is larger), `rounded-3xl`, capped at `max-w-lg` and
 * centred on a tablet. It sits on `--v2-z-nav-drawer` (140) and its scrim on
 * `--v2-z-nav-scrim` (130), both above the bar (105), and the scrim runs to
 * the viewport BOTTOM, edge to edge — so the pill is dimmed with everything
 * else and no scrim edge or undimmed strip is drawn anywhere.
 *
 * The scrim's TOP still stops at `--v2-safe-top`, deliberately unlike a modal
 * backdrop (which dims to `y=0`): the status-bar band stays the shell's
 * opaque `SafeAreaBand` and nothing translucent ever enters it. #2819 is the
 * reason — on an installed iPhone the band kept the old nav scrim's grey
 * after the drawer closed, and #2820 settled it by keeping the navigation's
 * cover of that strip opaque. Outside an installed app the inset is 0 and the
 * scrim reaches the top like any backdrop. It is `.v2-modal-backdrop`, so no
 * `backdrop-filter` either.
 *
 * ## Modal, and it closes itself
 *
 * The bar is covered, so the sheet carries its own ✕ — named `Close sidebar`,
 * the name the harness matches (the More cell is now only ever
 * `Open sidebar`). It is `aria-modal`: while it is open the tab bar and
 * `<main>` are `inert`, and Tab cycles inside the card. Focus moves in on open
 * and returns to the More control on a DISMISSAL (✕, Escape, scrim, swipe) —
 * after the `inert` comes off, since an inert control cannot take focus — but
 * not when a destination tap or a route change closes it. `useFocusTrap` is
 * not reused for that reason: it restores focus on every close. No scroll
 * lock: the page scrolls inside `<main>`, and the scrim is not a descendant of
 * it, so a drag on the scrim scrolls nothing.
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

  // A DISMISSAL (✕, Escape, scrim, swipe) hands focus back to the More
  // control. Navigating away does not: a destination link closes the sheet
  // too, and pulling focus back onto More after a route change would be
  // wrong. The hand-back happens in the `inert` effect's cleanup below,
  // because More is inside the inert bar until that cleanup runs.
  const refocusMore = useRef(false)
  const dismiss = useRef(() => {})
  dismiss.current = () => {
    refocusMore.current = true
    onClose()
  }

  // Modal (#4058): the page behind leaves the tab order and the a11y tree
  // while the sheet is open. The live bar is the one NAMED `Primary` — the
  // `/design-system` illustration is a nameless `inert` copy, and removing
  // `inert` from it on close would make its links focusable.
  useEffect(() => {
    if (!open) return
    const behind = Array.from(
      document.querySelectorAll<HTMLElement>('nav[data-mobile-tab-bar][aria-label="Primary"], #main-content'),
    )
    for (const el of behind) el.setAttribute('inert', '')
    return () => {
      for (const el of behind) el.removeAttribute('inert')
      if (refocusMore.current) {
        refocusMore.current = false
        returnFocusRef.current?.focus({ preventScroll: true })
      }
    }
  }, [open, returnFocusRef])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        dismiss.current()
        return
      }
      // Tab cycles inside the card: the page behind is inert, so without
      // this the next stop after the last row is the browser chrome.
      if (e.key === 'Tab' && sheetRef.current) {
        const stops = Array.from(sheetRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'))
        if (stops.length === 0) return
        const first = stops[0]
        const last = stops[stops.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
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


  return (
    <>
      <div
        aria-hidden="true"
        data-more-sheet-scrim=""
        onClick={() => dismiss.current()}
        className="lg:hidden fixed inset-x-0 top-[var(--v2-safe-top)] bottom-0 z-[var(--v2-z-nav-scrim)] v2-modal-backdrop"
      />
      <div
        ref={sheetRef}
        id="more-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="More"
        data-more-sheet=""
        data-state={settled ? 'open' : 'opening'}
        onAnimationEnd={(e) => {
          if (e.target === e.currentTarget) setSettled(true)
        }}
        style={dragY ? { transform: `translateY(${dragY}px)` } : undefined}
        // The float gap is 8px, or the home-indicator inset where that is
        // larger, so the card sits just above the indicator on a notched
        // phone. Written out twice (bottom, max-h) because Tailwind only
        // compiles class strings it can read whole.
        className="lg:hidden fixed left-[max(0.5rem,var(--v2-safe-left))] right-[max(0.5rem,var(--v2-safe-right))] bottom-[max(0.5rem,var(--v2-safe-bottom))] mx-auto z-[var(--v2-z-nav-drawer)] flex max-h-[calc(100dvh-var(--v2-safe-top)-max(0.5rem,var(--v2-safe-bottom))-1rem)] max-w-lg flex-col rounded-3xl border border-[var(--v2-border)] bg-[var(--v2-surface)] shadow-popover v2-sheet-enter"
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

        {/* The logo band and the sheet's own ✕ (#4058). The bar is covered,
            so this is the visible way out; it carries `Close sidebar`, the
            name the harness and the e2e fixtures match. */}
        <div className="flex flex-shrink-0 items-center justify-between gap-2 pr-3">
          {header}
          <button
            type="button"
            onClick={() => dismiss.current()}
            aria-label="Close sidebar"
            data-more-sheet-close=""
            className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-[var(--v2-ink-2)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
          >
            <span className="h-5 w-5" aria-hidden="true">
              <Icon icon={X} className="h-full w-full" />
            </span>
          </button>
        </div>

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
            {/* The row's tappable cue (#4056): on a phone this is the only
                route to Profile, and a bare name read as a label. Decorative —
                the link's name stays `Open profile for …`. */}
            <span aria-hidden="true" data-account-chevron="" className="inline-flex h-4 w-4 flex-shrink-0 text-[var(--v2-ink-3)]">
              <Icon icon={ChevronRight} className="h-full w-full" />
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
