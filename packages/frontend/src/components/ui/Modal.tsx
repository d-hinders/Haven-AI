'use client'

import { useEffect, useRef, type ReactNode } from 'react'

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  initialFocusRef,
  closeOnBackdrop = true,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  initialFocusRef?: React.RefObject<HTMLElement | null>
  closeOnBackdrop?: boolean
}) {
  const panelRef = useRef<HTMLDivElement>(null)

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
      if (event.key === 'Escape') {
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
  }, [initialFocusRef, onClose, open])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      className="fixed inset-0 z-[200] flex items-center justify-center p-4"
    >
      <div
        className="absolute inset-0 bg-[var(--v2-ink)]/40 backdrop-blur-sm"
        onClick={closeOnBackdrop ? onClose : undefined}
      />

      <div
        ref={panelRef}
        className="relative w-full max-w-md overflow-hidden rounded-[14px] border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-[var(--v2-shadow-modal)]"
      >
        <div className="p-6">
          <h2 id="modal-title" className="text-base font-semibold text-[var(--v2-ink)]">
            {title}
          </h2>
          <div className="mt-2 text-sm leading-relaxed text-[var(--v2-ink-2)]">
            {children}
          </div>
        </div>

        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-[var(--v2-border)] bg-[var(--v2-surface)] px-6 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
