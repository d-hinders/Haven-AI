import type { ReactNode } from 'react'
import { Card } from '@/components/ui/Card'
import { StatusBadge } from '@/components/ui/StatusBadge'

export function AgentBudgetCard({
  agentName,
  walletName,
  amount,
  resetPeriod,
  status = 'Draft',
  statusTone = 'brand',
  children,
}: {
  agentName: string
  walletName: string
  amount: string
  resetPeriod: string
  status?: string
  statusTone?: 'success' | 'warning' | 'danger' | 'neutral' | 'brand'
  children?: ReactNode
}) {
  return (
    <Card hover={false} className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-[var(--v2-ink-3)]">Agent budget</p>
          <h3 className="mt-1 text-base font-semibold text-[var(--v2-ink)]">{agentName}</h3>
        </div>
        <StatusBadge tone={statusTone}>{status}</StatusBadge>
      </div>

      <div className="mt-5 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
        <p className="text-xs font-medium text-[var(--v2-ink-3)]">Can spend</p>
        <p className="mt-1 text-2xl font-semibold tracking-tight text-[var(--v2-ink)] v2-tabular">
          {amount}
        </p>
        <p className="mt-1 text-sm text-[var(--v2-ink-2)]">{resetPeriod}</p>
      </div>

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium text-[var(--v2-ink-3)]">From wallet</dt>
          <dd className="mt-1 font-medium text-[var(--v2-ink)]">{walletName}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-[var(--v2-ink-3)]">Approval</dt>
          <dd className="mt-1 text-[var(--v2-ink-2)]">Required above budget</dd>
        </div>
      </dl>

      {children && <div className="mt-4 border-t border-[var(--v2-border)] pt-4">{children}</div>}
    </Card>
  )
}
