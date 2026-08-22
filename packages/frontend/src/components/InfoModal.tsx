'use client'

import { ChevronLeft, ChevronRight, MoveDown, MoveRight } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useState, useEffect, useCallback } from 'react'
import { Modal } from '@/components/ui/Modal'

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
          ? 'border-brand/30 bg-[var(--v2-brand-soft)]'
          : 'border-[var(--v2-border)] bg-[var(--v2-surface)]'
      } ${className}`}
    >
      <p className={`text-xs font-medium ${accent ? 'text-[var(--v2-brand)]' : 'text-[var(--v2-ink)]'}`}>
        {label}
      </p>
      {sub && <p className="text-xs text-[var(--v2-ink-3)] mt-0.5">{sub}</p>}
    </div>
  )
}

export function Arrow({ direction = 'down' }: { direction?: 'down' | 'right' }) {
  if (direction === 'right') {
    return (
      <div className="flex items-center justify-center px-1">
        <Icon icon={MoveRight} className="h-3 w-5 text-[var(--v2-ink-3)]" />
      </div>
    )
  }
  return (
    <div className="flex items-center justify-center py-1">
      <Icon icon={MoveDown} className="h-5 w-3 text-[var(--v2-ink-3)]" />
    </div>
  )
}

export function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block text-xs font-medium uppercase tracking-wider text-[var(--v2-brand)] bg-[var(--v2-brand-soft)] rounded px-1.5 py-0.5">
      {children}
    </span>
  )
}

/**
 * Numbered explanation step used inside InfoModal pages.
 *
 * Sizes are intentionally larger than the legacy inline markup (`text-xs`
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
      <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--v2-brand-soft)] ring-1 ring-inset ring-brand/20">
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

  const handleClose = useCallback(() => {
    setPage(0)
    onClose()
  }, [onClose])

  // Reset page when opening
  useEffect(() => {
    if (open) setPage(0)
  }, [open])

  if (!open || pages.length === 0) return null

  const current = pages[page]
  const isFirst = page === 0
  const isLast = page === pages.length - 1

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={current.title}
      subtitle={current.subtitle}
      showCloseButton
      width="lg"
      closeOnBackdrop={false}
      headerAccessory={
        pages.length > 1 ? (
          <div className="flex items-center justify-center gap-1.5">
            {pages.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setPage(i)}
                aria-label={`Go to page ${i + 1}: ${pages[i].title}`}
                aria-current={i === page ? 'step' : undefined}
                className={`h-1.5 rounded-full transition-all duration-200 ${
                  i === page
                    ? 'w-6 bg-[var(--v2-brand)]'
                    : 'w-1.5 bg-[var(--v2-border-strong)] hover:bg-[var(--v2-ink-3)]'
                }`}
              />
            ))}
          </div>
        ) : undefined
      }
      bodyClassName="px-6 py-5"
      footer={
        pages.length > 1 ? (
          <div className="flex w-full items-center justify-between">
            <button
              type="button"
              onClick={() => setPage((p) => p - 1)}
              disabled={isFirst}
              className="text-sm text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] disabled:opacity-0 disabled:cursor-default transition-colors flex items-center gap-1"
            >
              <Icon icon={ChevronLeft} className="h-3.5 w-3.5" />
              Previous
            </button>

            <span className="text-xs text-[var(--v2-ink-3)]">
              {page + 1} / {pages.length}
            </span>

            {isLast ? (
              <button
                type="button"
                onClick={handleClose}
                className="text-sm font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors"
              >
                Done
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setPage((p) => p + 1)}
                className="text-sm text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] transition-colors flex items-center gap-1"
              >
                Next
                <Icon icon={ChevronRight} className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ) : undefined
      }
    >
      {current.content}
    </Modal>
  )
}
