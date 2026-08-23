'use client'

import { X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Icon } from './Icon'

/**
 * Sub-pixel slack for the "is there more below" test.
 *
 * `scrollHeight` and `clientHeight` are integers while `scrollTop` is
 * fractional under a non-integer device pixel ratio, so a body scrolled fully
 * to the end can report a remainder just under 1. Anything at or below this is
 * the end of the scroll, not content hiding under the fold.
 */
const SCROLL_END_EPSILON_PX = 1

const widthClasses = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
} as const

type ModalWidth = keyof typeof widthClasses

const maxHeightClasses = {
  default: 'max-h-[calc(100vh-2rem)]',
  tight: 'max-h-[calc(100vh-24px)]',
} as const

type ModalMaxHeight = keyof typeof maxHeightClasses

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  subtitle,
  headerAccessory,
  initialFocusRef,
  closeOnBackdrop = true,
  closeOnEscape = true,
  showCloseButton = false,
  closeButtonDisabled = false,
  width = 'md',
  maxHeight = 'default',
  bodyClassName = '',
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  subtitle?: ReactNode
  /** Content shown beneath the header, such as step progress. */
  headerAccessory?: ReactNode
  initialFocusRef?: React.RefObject<HTMLElement | null>
  closeOnBackdrop?: boolean
  closeOnEscape?: boolean
  showCloseButton?: boolean
  closeButtonDisabled?: boolean
  width?: ModalWidth
  maxHeight?: ModalMaxHeight
  bodyClassName?: string
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const [hasContentBelow, setHasContentBelow] = useState(false)

  /**
   * The continuation cue (#1893), measured rather than declared by the caller.
   *
   * Two structural facts about this component make the obvious shortcuts wrong,
   * so they are written down here instead of being rediscovered:
   *
   * 1. **`role="dialog"` is on the `fixed inset-0` WRAPPER below, not on the
   *    scrolling body.** The wrapper never scrolls. A guard that reaches for
   *    `getByRole('dialog')` and reads scroll geometry off it measures an
   *    element whose `scrollHeight` always equals its `clientHeight` — a check
   *    that cannot fail. The scroller is the `data-modal-body` element, and
   *    that attribute exists so tests have an honest handle on it.
   * 2. **The footer is rendered OUTSIDE this scroll box**, as a flex sibling.
   *    So a cue parked with the footer would sit below a region it says nothing
   *    about. The overlay is absolutely positioned against a wrapper that
   *    contains only the scroll box, which is why that wrapper exists.
   *
   * The condition is pure geometry — `scrollHeight > clientHeight + scrollTop`
   * — so a dialog whose content grows after mount (the re-key flow's residual
   * and resume banners do exactly that) is correct without any caller opting
   * in. `ResizeObserver` alone would not see that growth: the scroll box is a
   * flex child with a fixed height, so its own border box never changes when
   * its content does. Hence the observer is pointed at the CHILDREN too, and a
   * `MutationObserver` re-points it when the child list changes.
   */
  useEffect(() => {
    if (!open) return
    const body = bodyRef.current
    if (!body) return

    const measure = () => {
      setHasContentBelow(
        body.scrollHeight - body.clientHeight - body.scrollTop > SCROLL_END_EPSILON_PX,
      )
    }

    const resizeObserver = new ResizeObserver(measure)
    const observeChildren = () => {
      resizeObserver.disconnect()
      resizeObserver.observe(body)
      for (const child of Array.from(body.children)) resizeObserver.observe(child)
    }

    const mutationObserver = new MutationObserver(() => {
      observeChildren()
      measure()
    })

    observeChildren()
    measure()
    body.addEventListener('scroll', measure, { passive: true })
    mutationObserver.observe(body, { childList: true, subtree: true, characterData: true })

    return () => {
      body.removeEventListener('scroll', measure)
      resizeObserver.disconnect()
      mutationObserver.disconnect()
    }
  }, [open])

  useEffect(() => {
    if (!open) return

    const focusTarget =
      initialFocusRef?.current ??
      panelRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
    const previousActiveElement = document.activeElement as HTMLElement | null
    focusTarget?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && closeOnEscape) {
        onClose()
        return
      }

      if (event.key !== 'Tab' || !panelRef.current) return

      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      )
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previousActiveElement?.focus()
    }
  }, [closeOnEscape, initialFocusRef, onClose, open])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-[var(--v2-z-modal)] flex items-center justify-center p-4"
    >
      <div
        className="absolute inset-0 v2-modal-backdrop"
        onClick={closeOnBackdrop ? onClose : undefined}
      />

      <div
        ref={panelRef}
        className={`relative flex w-full flex-col overflow-hidden rounded-[14px] border border-[var(--v2-border)] bg-white shadow-modal ${maxHeightClasses[maxHeight]} ${widthClasses[width]}`}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--v2-border)] px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-semibold text-[var(--v2-ink)]">
              {title}
            </h2>
            {subtitle && (
              <div className="mt-0.5 text-xs leading-relaxed text-[var(--v2-ink-3)]">
                {subtitle}
              </div>
            )}
          </div>
          {showCloseButton && (
            <button
              type="button"
              onClick={onClose}
              disabled={closeButtonDisabled}
              aria-label="Close"
              className="-m-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 disabled:cursor-not-allowed disabled:opacity-20"
            >
              <Icon icon={X} className="h-4 w-4" />
            </button>
          )}
        </div>

        {headerAccessory && (
          <div className="shrink-0 border-b border-[var(--v2-border)] px-5 py-3">
            {headerAccessory}
          </div>
        )}

        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={bodyRef}
            data-modal-body=""
            className={`min-h-0 flex-1 overflow-y-auto p-6 text-sm leading-relaxed text-[var(--v2-ink-2)] ${bodyClassName}`}
          >
            {children}
          </div>

          {/*
            Non-occluding by construction: a 6px translucent inset shadow that
            DARKENS the last sliver of the scroll box rather than painting over
            it. Nothing is hidden and nothing is bleached, whatever surface the
            body's last line happens to sit on. The token carries the reasoning
            and the two rejected alternatives.

            No transition ON THE INITIAL, MOUNT-TIME APPEARANCE, on purpose —
            and the claim is scoped to that deliberately. A dialog that opens
            already overflowing gets its first honest reading in the effect
            above, i.e. right after the first commit, so a fade-in there would
            be exactly the first-paint entrance motion
            `docs/product/design-system.md` § 4 bans, in every overflowing
            dialog in the app.

            That argument does NOT reach the recurring toggles while a user is
            actively scrolling an open dialog. Those are not first-paint motion
            and sit closer to the transitions § 4 allows, which
            `docs/product/design-review.md` would require to be gated behind
            `prefers-reduced-motion: no-preference`. Whether they should have
            one is an OPEN question, not a decision taken here: at 6px the snap
            is a hairline rather than a flash, and it costs no layout shift —
            measured across a real scroll, the body holds `clientHeight` 362 and
            `top` 169 while the cue toggles, because the cue is a pure overlay.
            Verified by scrolling a real dialog, not by reading a still.
          */}
          {hasContentBelow && (
            <div
              data-modal-scroll-cue=""
              aria-hidden="true"
              className="v2-scroll-edge-cue pointer-events-none absolute inset-x-0 bottom-0 h-1.5"
            />
          )}
        </div>

        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--v2-border)] bg-[var(--v2-surface)] px-6 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
