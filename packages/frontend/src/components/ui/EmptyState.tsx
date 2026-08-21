import type { ReactNode } from 'react'

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger'
type Size = 'default' | 'compact' | 'inline'

interface EmptyStateProps {
  icon?: ReactNode
  /** Tone of the leading icon's tinted circle. Defaults to `brand`. */
  tone?: Tone
  title: string
  body?: ReactNode
  action?: ReactNode
  /**
   * `default` — page/section-level empty state (roomy, icon halo).
   * `compact` — in-card previews and side columns (tighter padding + type).
   * `inline` — a one-line dashed placeholder inside dense content (renders
   * the title only; icon/body/action belong to the larger sizes).
   */
  size?: Size
  className?: string
}

const TONE_CLASSES: Record<Tone, { iconBg: string; iconColor: string; halo: string }> = {
  brand: {
    iconBg: 'bg-[var(--v2-brand-soft)]',
    iconColor: 'text-[var(--v2-brand)]',
    halo: 'ring-brand/10',
  },
  success: {
    iconBg: 'bg-[var(--v2-success-soft)]',
    iconColor: 'text-[var(--v2-success)]',
    halo: 'ring-success/10',
  },
  warning: {
    iconBg: 'bg-[var(--v2-warning-soft)]',
    iconColor: 'text-[var(--v2-warning)]',
    halo: 'ring-warning/10',
  },
  danger: {
    iconBg: 'bg-[var(--v2-danger-soft)]',
    iconColor: 'text-[var(--v2-danger)]',
    halo: 'ring-danger/10',
  },
  neutral: {
    iconBg: 'bg-[var(--v2-surface-2)]',
    iconColor: 'text-[var(--v2-ink-2)]',
    // 40%, not the 10% its four siblings use: this halo is a low-chroma grey,
    // and at 10% it would be all but invisible against --v2-surface-2. The
    // higher opacity buys the SAME visual weight, not more. Don't "fix" it
    // into false consistency with the tinted tones (#1708 design review).
    halo: 'ring-border/40',
  },
}

export function EmptyState({
  icon,
  tone = 'brand',
  title,
  body,
  action,
  size = 'default',
  className = '',
}: EmptyStateProps) {
  const palette = TONE_CLASSES[tone]
  const shell =
    'rounded-[10px] border border-dashed border-[var(--v2-border-strong)] bg-[var(--v2-surface)] text-center'

  if (size === 'inline') {
    return (
      <div className={`${shell} px-3 py-2.5 text-xs text-[var(--v2-ink-3)] ${className}`}>
        {title}
      </div>
    )
  }

  const isCompact = size === 'compact'
  return (
    <div className={`${shell} ${isCompact ? 'p-6' : 'px-6 py-10'} ${className}`}>
      {icon && (
        <div
          className={`mx-auto flex items-center justify-center rounded-full ring-4 ${
            isCompact ? 'mb-3 h-8 w-8' : 'mb-4 h-10 w-10'
          } ${palette.iconBg} ${palette.iconColor} ${palette.halo}`}
        >
          <span className={`inline-flex items-center justify-center ${isCompact ? 'h-4 w-4' : 'h-5 w-5'}`}>
            {icon}
          </span>
        </div>
      )}
      <h3 className={`text-sm text-[var(--v2-ink)] ${isCompact ? 'font-medium' : 'font-semibold'}`}>
        {title}
      </h3>
      {body && (
        <div
          className={`mx-auto mt-2 max-w-sm leading-relaxed text-[var(--v2-ink-2)] ${
            isCompact ? 'text-xs' : 'text-sm'
          }`}
        >
          {body}
        </div>
      )}
      {action && <div className={isCompact ? 'mt-4' : 'mt-5'}>{action}</div>}
    </div>
  )
}
