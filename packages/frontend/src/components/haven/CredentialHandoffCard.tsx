import type { ReactNode } from 'react'
import { Card } from '@/components/ui/Card'
import { StatusBadge } from '@/components/ui/StatusBadge'

export function CredentialHandoffCard({
  title = 'Credential file',
  description,
  primaryAction,
  secondaryAction,
  note,
}: {
  title?: string
  description: ReactNode
  primaryAction: ReactNode
  secondaryAction?: ReactNode
  note?: ReactNode
}) {
  return (
    <Card hover={false} className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-[var(--v2-ink)]">{title}</h3>
            <StatusBadge tone="brand">Save now</StatusBadge>
          </div>
          <div className="mt-1 text-sm leading-relaxed text-[var(--v2-ink-2)]">{description}</div>
        </div>
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[10px] bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]">
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
            <path d="M7 3.75h7.25L18 7.5v12.75H7V3.75Z" strokeLinejoin="round" />
            <path d="M14.25 3.75V7.5H18M9.5 13.25h5M9.5 16h5M9.5 10.5h2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {primaryAction}
        {secondaryAction}
      </div>

      {note && <div className="mt-3 text-xs leading-relaxed text-[var(--v2-ink-3)]">{note}</div>}
    </Card>
  )
}
