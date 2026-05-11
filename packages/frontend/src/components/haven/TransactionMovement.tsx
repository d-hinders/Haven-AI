import type { ReactNode } from 'react'

export function TransactionMovement({
  from,
  to,
}: {
  from: ReactNode
  to: ReactNode
}) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="min-w-0">
        <span className="text-[var(--v2-ink-3)]">From </span>
        <span className="font-medium text-[var(--v2-ink)]">{from}</span>
      </span>
      <span aria-hidden="true" className="text-[var(--v2-ink-3)]">→</span>
      <span className="min-w-0">
        <span className="text-[var(--v2-ink-3)]">To </span>
        <span className="font-medium text-[var(--v2-ink)]">{to}</span>
      </span>
    </span>
  )
}
