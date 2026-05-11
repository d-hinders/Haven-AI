import type { ReactNode } from 'react'
import { StatusBadge } from '@/components/ui/StatusBadge'

export function AgentActivityRow({
  title,
  description,
  amount,
  status,
  statusTone,
  timestamp,
  action,
}: {
  title: string
  description: ReactNode
  amount: string
  status: string
  statusTone: 'success' | 'warning' | 'danger' | 'neutral' | 'brand'
  timestamp?: string
  action?: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[var(--v2-border)] px-5 py-4 last:border-b-0">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium text-[var(--v2-ink)]">{title}</p>
          <StatusBadge tone={statusTone}>{status}</StatusBadge>
        </div>
        <div className="mt-1 truncate text-xs text-[var(--v2-ink-2)]">{description}</div>
      </div>
      <div className="flex-shrink-0 text-right">
        <p className="text-sm font-semibold text-[var(--v2-ink)] v2-tabular">{amount}</p>
        {action ? <div className="mt-1">{action}</div> : null}
        {timestamp ? <p className="mt-1 text-xs text-[var(--v2-ink-2)]">{timestamp}</p> : null}
      </div>
    </div>
  )
}
