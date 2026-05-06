import type { ReactNode } from 'react'

type StatusTone = 'success' | 'warning' | 'danger' | 'neutral' | 'brand'

const TONE_CLASS: Record<StatusTone, string> = {
  success: 'bg-[var(--v2-success-soft)] text-[var(--v2-success)]',
  warning: 'bg-[var(--v2-warning-soft)] text-[var(--v2-warning)]',
  danger: 'bg-[var(--v2-danger-soft)] text-[var(--v2-danger)]',
  neutral: 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-2)]',
  brand: 'bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]',
}

export function StatusBadge({
  children,
  tone = 'neutral',
  className = '',
}: {
  children: ReactNode
  tone?: StatusTone
  className?: string
}) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE_CLASS[tone]} ${className}`}>
      {children}
    </span>
  )
}
