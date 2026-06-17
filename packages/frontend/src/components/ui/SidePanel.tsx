'use client'

import { useRef, type ReactNode } from 'react'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { useFocusTrap } from '@/hooks/useFocusTrap'

/**
 * Right-hand drawer. A sibling to `Modal` for content that benefits from a
 * tall, scannable column rather than a centered dialog — e.g. the per-type
 * transaction detail view. Backdrop click and Escape close it; focus is
 * trapped while open.
 */
export function SidePanel({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  useEscapeToClose(open, onClose)
  useFocusTrap(panelRef, open)

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[200] flex justify-end">
      <div className="absolute inset-0 v2-modal-backdrop" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : 'Details'}
        className="v2-animate-panel-in relative flex h-full w-full max-w-md flex-col border-l border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-modal)]"
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--v2-border)] px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-[var(--v2-ink)]">{title}</h2>
            {subtitle ? (
              <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]">{subtitle}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 rounded-md p-1 text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>

        {footer ? (
          <div className="border-t border-[var(--v2-border)] px-5 py-4">{footer}</div>
        ) : null}
      </div>
    </div>
  )
}
