import type { ReactNode } from 'react'

export type StatusTone = 'success' | 'warning' | 'danger' | 'neutral' | 'brand'

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
    // #2147: `whitespace-nowrap` because `rounded-full` is a STADIUM — it is a
    // one-line shape, and wrapped text turns it into an over-rounded blob that
    // stops reading as a status chip. Nothing wrapped here until #2147 seeded
    // `needs_attention`, whose "Needs attention" is the longest label in the
    // `MachinePaymentFlowStatus` vocabulary and the first to wrap at 390 in the
    // activity table's narrow column (`haven-design-reviewer`'s should-fix, on
    // the capture that state's first-ever rendering produced). Every other
    // badge in the app already fits on one line, so this changes no existing
    // rendering; `StatusBadge.test.tsx` holds the shape and the rule together.
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASS[tone]} ${className}`}>
      {children}
    </span>
  )
}
