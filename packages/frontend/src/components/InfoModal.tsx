'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { useFocusTrap } from '@/hooks/useFocusTrap'

// ── Shared visual components ──────────────────────────────────────

export function DiagramBox({
  label,
  sub,
  accent = false,
  className = '',
}: {
  label: string
  sub?: string
  accent?: boolean
  className?: string
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-center ${
        accent
          ? 'border-[var(--v2-brand)]/30 bg-[var(--v2-brand-soft)]'
          : 'border-[var(--v2-border)] bg-[var(--v2-surface)]'
      } ${className}`}
    >
      <p className={`text-xs font-medium ${accent ? 'text-[var(--v2-brand)]' : 'text-[var(--v2-ink)]'}`}>
        {label}
      </p>
      {sub && <p className="text-[10px] text-[var(--v2-ink-3)] mt-0.5">{sub}</p>}
    </div>
  )
}

export function Arrow({ direction = 'down' }: { direction?: 'down' | 'right' }) {
  if (direction === 'right') {
    return (
      <div className="flex items-center justify-center px-1">
        <svg width="20" height="12" viewBox="0 0 20 12" fill="none" className="text-[var(--v2-ink-3)]">
          <path d="M0 6h16M12 1l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    )
  }
  return (
    <div className="flex items-center justify-center py-1">
      <svg width="12" height="20" viewBox="0 0 12 20" fill="none" className="text-[var(--v2-ink-3)]">
        <path d="M6 0v16M1 12l5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
}

export function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block text-[10px] font-medium uppercase tracking-wider text-[var(--v2-brand)] bg-[var(--v2-brand-soft)] rounded px-1.5 py-0.5">
      {children}
    </span>
  )
}

/**
 * Numbered explanation step used inside InfoModal pages.
 *
 * Sizes are intentionally larger than the legacy inline markup (`text-[11px]`
 * etc.) — body text at 13–14px lands within WCAG-friendly territory and
 * matches the readability bump applied across V2 modals.
 */
export function InfoStep({
  number,
  title,
  children,
}: {
  number: number
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4 transition-colors hover:border-[var(--v2-border-strong)]">
      <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--v2-brand-soft)] ring-1 ring-inset ring-[var(--v2-brand)]/20">
        <span className="text-xs font-semibold text-[var(--v2-brand)]">{number}</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-[var(--v2-ink)]">{title}</p>
        <div className="mt-1 text-[13px] leading-relaxed text-[var(--v2-ink-2)]">{children}</div>
      </div>
    </div>
  )
}

/**
 * Footnote / aside block used inside InfoModal pages. Sits at body-readable
 * size (13px) rather than the legacy 11px tint that made these notes feel
 * like fine print.
 */
export function InfoNote({
  label,
  children,
}: {
  label?: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-3 text-[13px] leading-relaxed text-[var(--v2-ink-2)]">
      {label && (
        <span className="font-medium text-[var(--v2-ink)]">{label}</span>
      )}{' '}
      {children}
    </div>
  )
}

// ── Page type ─────────────────────────────────────────────────────

export interface InfoPage {
  title: string
  subtitle: string
  content: React.ReactNode
}

// ── Modal component ───────────────────────────────────────────────

interface Props {
  open: boolean
  onClose: () => void
  pages: InfoPage[]
}

export default function InfoModal({ open, onClose, pages }: Props) {
  const [page, setPage] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)

  const handleClose = useCallback(() => {
    setPage(0)
    onClose()
  }, [onClose])

  // Reset page when opening
  useEffect(() => {
    if (open) setPage(0)
  }, [open])

  useEscapeToClose(open, handleClose)
  useFocusTrap(panelRef, open)

  if (!open || pages.length === 0) return null

  const current = pages[page]
  const isFirst = page === 0
  const isLast = page === pages.length - 1

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 v2-modal-backdrop">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="info-modal-title"
        className="bg-white border border-[var(--v2-border)] rounded-2xl w-full max-w-lg shadow-[var(--v2-shadow-modal)] max-h-[90vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-[var(--v2-border)] flex-shrink-0">
          <div className="min-w-0">
            <h2 id="info-modal-title" className="text-base font-semibold text-[var(--v2-ink)] leading-tight">{current.title}</h2>
            <p className="text-sm text-[var(--v2-ink-3)] mt-1 leading-snug">{current.subtitle}</p>
          </div>
          <button
            onClick={handleClose}
            aria-label="Close"
            className="p-1.5 -mr-1 rounded-md text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Page dots */}
        {pages.length > 1 && (
          <div className="flex items-center justify-center gap-1.5 px-6 py-3 border-b border-[var(--v2-border)] flex-shrink-0">
            {pages.map((_, i) => (
              <button
                key={i}
                onClick={() => setPage(i)}
                className={`h-1.5 rounded-full transition-all duration-200 ${
                  i === page
                    ? 'w-6 bg-[var(--v2-brand)]'
                    : 'w-1.5 bg-[var(--v2-border-strong)] hover:bg-[var(--v2-ink-3)]'
                }`}
              />
            ))}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {current.content}
        </div>

        {/* Navigation */}
        {pages.length > 1 && (
          <div className="flex items-center justify-between px-6 py-4 border-t border-[var(--v2-border)] flex-shrink-0">
            <button
              onClick={() => setPage((p) => p - 1)}
              disabled={isFirst}
              className="text-sm text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] disabled:opacity-0 disabled:cursor-default transition-colors flex items-center gap-1"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
              Previous
            </button>

            <span className="text-xs text-[var(--v2-ink-3)]">
              {page + 1} / {pages.length}
            </span>

            {isLast ? (
              <button
                onClick={handleClose}
                className="text-sm font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors"
              >
                Done
              </button>
            ) : (
              <button
                onClick={() => setPage((p) => p + 1)}
                className="text-sm text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] transition-colors flex items-center gap-1"
              >
                Next
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
