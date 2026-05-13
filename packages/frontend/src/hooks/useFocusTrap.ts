'use client'

import { useEffect } from 'react'

interface UseFocusTrapOptions {
  /** Optional CSS selector for the initial focus target inside the panel. Defaults to the first focusable element. */
  initialFocusSelector?: string
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'button:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * Trap keyboard focus inside `panelRef` while `open` is true. On open,
 * focus moves to the first focusable element (or `initialFocusSelector`).
 * On close, focus returns to whichever element opened the modal.
 *
 * Cooperates with useEscapeToClose — they listen to different keys and
 * neither stops propagation.
 */
export function useFocusTrap(
  panelRef: React.RefObject<HTMLElement | null>,
  open: boolean,
  options: UseFocusTrapOptions = {},
) {
  const { initialFocusSelector } = options

  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    if (!panel) return

    const previousActiveElement = document.activeElement as HTMLElement | null

    // Move focus inside the panel on open.
    const focusInitial = () => {
      const target = initialFocusSelector
        ? panel.querySelector<HTMLElement>(initialFocusSelector)
        : panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
      target?.focus()
    }
    // Defer to next frame so the panel is in the DOM and any
    // autoFocus has already run.
    const raf = window.requestAnimationFrame(focusInitial)

    // Trap Tab / Shift+Tab inside the panel.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const focusable = panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (event.shiftKey) {
        if (active === first || !panel.contains(active)) {
          event.preventDefault()
          last.focus()
        }
      } else {
        if (active === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)

    return () => {
      window.cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKeyDown)
      // Restore focus to whoever opened the modal.
      if (previousActiveElement && typeof previousActiveElement.focus === 'function') {
        previousActiveElement.focus()
      }
    }
  }, [open, panelRef, initialFocusSelector])
}

export default useFocusTrap
