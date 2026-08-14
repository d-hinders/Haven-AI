'use client'

import { X } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Icon } from './Icon'

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
  const titleId = useId()

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
      className="fixed inset-0 z-[200] flex items-center justify-center p-4"
    >
      <div
        className="absolute inset-0 v2-modal-backdrop"
        onClick={closeOnBackdrop ? onClose : undefined}
      />

      <div
        ref={panelRef}
        className={`relative flex w-full flex-col overflow-hidden rounded-[14px] border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-modal)] ${maxHeightClasses[maxHeight]} ${widthClasses[width]}`}
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
              className="-m-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30 disabled:cursor-not-allowed disabled:opacity-20"
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

        <div className={`min-h-0 flex-1 overflow-y-auto p-6 text-sm leading-relaxed text-[var(--v2-ink-2)] ${bodyClassName}`}>
          {children}
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
