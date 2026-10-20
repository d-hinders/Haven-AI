'use client'

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'

/**
 * The menu-button behaviour `FacetMenu` and `PeriodPicker` share (#4110).
 * A hook, not a component: the two render different panels, and what they
 * share is the keyboard contract and the viewport clamp.
 *
 * - The trigger is a menu button: `aria-haspopup="menu"`, `aria-expanded`,
 *   `aria-controls` while open. Enter / Space (the native click) and
 *   Arrow Down open it on the checked item (else the first); Arrow Up opens
 *   it on the last.
 * - Inside, Arrow Up / Down move with wrap, Home / End jump; items are
 *   `tabIndex={-1}` so Tab leaves the menu (and closes it) instead of
 *   walking every option.
 * - Escape closes and returns focus to the trigger. A click outside closes
 *   without moving focus.
 * - The panel never extends past the viewport: after it opens, it is
 *   measured and shifted back inside an 8px margin (`menuShift`).
 */

/** The system focus ring, as `Button`/`Input`/`Select` carry it. */
export const listFocusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)]'

/**
 * A chip trigger. 44px tall below `sm` (a phone tap target), the 38px
 * desktop chip above it.
 */
export function listTriggerClasses(active: boolean): string {
  return [
    'inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-md border px-3 py-2 text-sm transition-colors sm:min-h-[38px]',
    listFocusRing,
    active
      ? 'border-brand/30 bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]'
      : 'border-[var(--v2-border)] bg-[var(--v2-bg)] text-[var(--v2-ink-2)] hover:bg-[var(--v2-surface)] hover:text-[var(--v2-ink)]',
  ].join(' ')
}

/**
 * The floating panel's box. Width is capped to the viewport less 16px. One
 * step above `--v2-z-sticky`, so a sticky table header below the toolbar
 * cannot paint over an open menu, and still below the chrome.
 */
export const listMenuPanelClasses =
  'absolute top-full z-[calc(var(--v2-z-sticky)+1)] mt-1.5 flex max-h-[min(24rem,70vh)] w-max min-w-[13rem] max-w-[calc(100vw-1rem)] flex-col overflow-y-auto rounded-lg border border-[var(--v2-border)] bg-[var(--v2-bg)] p-1 shadow-modal sm:max-w-[22rem]'

/** One option row inside a menu panel. 44px below `sm`. */
export const listMenuItemClasses = `grid min-h-11 w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-[var(--v2-ink)] hover:bg-[var(--v2-surface)] focus-visible:bg-[var(--v2-surface)] sm:min-h-0 ${listFocusRing}`

export const menuViewportMargin = 8

/**
 * How far to move a panel horizontally so it sits inside the viewport with
 * `margin` to spare on both sides. Pure, so the clamp is unit-tested; the
 * 375px proof against real layout is the e2e spec.
 */
export function menuShift(
  rect: { left: number; right: number },
  viewportWidth: number,
  margin: number = menuViewportMargin,
): number {
  let shift = 0
  if (rect.right > viewportWidth - margin) shift = viewportWidth - margin - rect.right
  if (rect.left + shift < margin) shift = margin - rect.left
  return shift
}

const ITEM_SELECTOR = '[role="menuitemradio"]:not([disabled]),[role="menuitemcheckbox"]:not([disabled]),[role="menuitem"]:not([disabled])'

type FocusTarget = 'checked' | 'first' | 'last' | 'none'

export function useListMenu() {
  const [open, setOpenRaw] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const focusOnOpen = useRef<FocusTarget>('checked')
  const [shift, setShift] = useState(0)
  const baseId = useId()
  const menuId = `${baseId}-menu`
  const triggerId = `${baseId}-trigger`

  const items = useCallback(
    () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []),
    [],
  )

  const openWith = useCallback((target: FocusTarget) => {
    focusOnOpen.current = target
    setOpenRaw(true)
  }, [])

  const close = useCallback((returnFocus: boolean) => {
    setOpenRaw(false)
    setShift(0)
    if (returnFocus) triggerRef.current?.focus()
  }, [])

  /** Focus a given target inside the panel (also used after a view swap). */
  const focusItem = useCallback(
    (target: FocusTarget) => {
      const list = items()
      if (target === 'none' || list.length === 0) return
      const checked = list.find((el) => el.getAttribute('aria-checked') === 'true')
      const el = target === 'last' ? list[list.length - 1] : target === 'checked' ? (checked ?? list[0]) : list[0]
      el?.focus()
    },
    [items],
  )

  // Measure and clamp, then move focus in — before paint, so the panel never
  // flashes past the edge.
  useLayoutEffect(() => {
    if (!open) return
    const panel = panelRef.current
    if (panel && typeof window !== 'undefined') {
      const rect = panel.getBoundingClientRect()
      const viewport = document.documentElement.clientWidth || window.innerWidth
      setShift(menuShift(rect, viewport))
    }
    focusItem(focusOnOpen.current)
  }, [open, focusItem])

  // Close on a pointer press outside the trigger and the panel.
  useEffect(() => {
    if (!open) return
    function handler(event: MouseEvent) {
      if (wrapperRef.current?.contains(event.target as Node)) return
      close(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, close])

  const onTriggerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        if (open) focusItem('checked')
        else openWith('checked')
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        if (open) focusItem('last')
        else openWith('last')
      } else if (event.key === 'Escape' && open) {
        event.preventDefault()
        event.stopPropagation()
        close(true)
      }
    },
    [open, openWith, focusItem, close],
  )

  const onTriggerClick = useCallback(() => {
    if (open) close(false)
    else openWith('checked')
  }, [open, close, openWith])

  const onPanelKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close(true)
        return
      }
      if (event.key === 'Tab') {
        close(false)
        return
      }
      const list = items()
      if (list.length === 0) return
      const index = list.findIndex((el) => el === document.activeElement)
      let next: HTMLElement | undefined
      if (event.key === 'ArrowDown') next = list[index < 0 ? 0 : (index + 1) % list.length]
      else if (event.key === 'ArrowUp') next = list[index < 0 ? list.length - 1 : (index - 1 + list.length) % list.length]
      else if (event.key === 'Home') next = list[0]
      else if (event.key === 'End') next = list[list.length - 1]
      if (next) {
        event.preventDefault()
        next.focus()
      }
    },
    [items, close],
  )

  const panelStyle: CSSProperties | undefined = shift ? { transform: `translateX(${shift}px)` } : undefined

  return {
    open,
    close,
    focusItem,
    menuId,
    triggerId,
    triggerRef,
    panelRef,
    wrapperRef,
    panelStyle,
    triggerProps: {
      ref: triggerRef,
      id: triggerId,
      type: 'button' as const,
      'aria-haspopup': 'menu' as const,
      'aria-expanded': open,
      'aria-controls': open ? menuId : undefined,
      onClick: onTriggerClick,
      onKeyDown: onTriggerKeyDown,
    },
    onPanelKeyDown,
  }
}
