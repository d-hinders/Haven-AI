import type { ReactNode } from 'react'

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger'

interface EmptyStateProps {
  icon?: ReactNode
  /** Tone of the leading icon's tinted circle. Defaults to `brand`. */
  tone?: Tone
  title: string
  body?: ReactNode
  action?: ReactNode
  className?: string
}

const TONE_CLASSES: Record<Tone, { iconBg: string; iconColor: string; halo: string }> = {
  brand: {
    iconBg: 'bg-[var(--v2-brand-soft)]',
    iconColor: 'text-[var(--v2-brand)]',
    halo: 'ring-[var(--v2-brand)]/10',
  },
  success: {
    iconBg: 'bg-[var(--v2-success-soft)]',
    iconColor: 'text-[var(--v2-success)]',
    halo: 'ring-[var(--v2-success)]/10',
  },
  warning: {
    iconBg: 'bg-[var(--v2-warning-soft)]',
    iconColor: 'text-[var(--v2-warning)]',
    halo: 'ring-[var(--v2-warning)]/10',
  },
  danger: {
    iconBg: 'bg-[var(--v2-danger-soft)]',
    iconColor: 'text-[var(--v2-danger)]',
    halo: 'ring-[var(--v2-danger)]/10',
  },
  neutral: {
    iconBg: 'bg-[var(--v2-surface-2)]',
    iconColor: 'text-[var(--v2-ink-2)]',
    halo: 'ring-[var(--v2-border)]/40',
  },
}

export function EmptyState({
  icon,
  tone = 'brand',
  title,
  body,
  action,
  className = '',
}: EmptyStateProps) {
  const palette = TONE_CLASSES[tone]
  return (
    <div
      className={`rounded-[10px] border border-dashed border-[var(--v2-border-strong)] bg-[var(--v2-surface)] px-6 py-10 text-center ${className}`}
    >
      {icon && (
        <div
          className={`mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full ring-4 ${palette.iconBg} ${palette.iconColor} ${palette.halo}`}
        >
          <span className="inline-flex h-5 w-5 items-center justify-center">{icon}</span>
        </div>
      )}
      <h3 className="text-sm font-semibold text-[var(--v2-ink)]">{title}</h3>
      {body && (
        <div className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[var(--v2-ink-2)]">
          {body}
        </div>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
