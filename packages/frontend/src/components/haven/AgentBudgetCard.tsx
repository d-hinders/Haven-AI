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
  density = 'normal',
  children,
}: {
  agentName: string
  walletName: string
  amount: string
  resetPeriod: string
  status?: string
  statusTone?: 'success' | 'warning' | 'danger' | 'neutral' | 'brand'
  density?: 'normal' | 'compact'
  children?: ReactNode
}) {
  const compact = density === 'compact'

  return (
    <Card hover={false} className={compact ? 'p-4' : 'p-5'}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-[var(--v2-ink-3)]">Agent budget</p>
          <h3 className={`${compact ? 'mt-0.5 text-sm' : 'mt-1 text-base'} font-semibold text-[var(--v2-ink)]`}>
            {agentName}
          </h3>
        </div>
        <StatusBadge tone={statusTone}>{status}</StatusBadge>
      </div>

      <div className={`${compact ? 'mt-3 p-3' : 'mt-5 p-4'} rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)]`}>
        <p className="text-xs font-medium text-[var(--v2-ink-3)]">Can spend</p>
        <p className={`${compact ? 'text-xl' : 'text-2xl'} mt-1 font-semibold tracking-tight text-[var(--v2-ink)] v2-tabular`}>
          {amount}
        </p>
        <p className={`${compact ? 'text-xs' : 'text-sm'} mt-1 text-[var(--v2-ink-2)]`}>{resetPeriod}</p>
      </div>

      <dl className={`${compact ? 'mt-3 gap-2 text-xs' : 'mt-4 gap-3 text-sm'} grid sm:grid-cols-2`}>
        <div>
          <dt className="text-xs font-medium text-[var(--v2-ink-3)]">From wallet</dt>
          <dd className="mt-1 font-medium text-[var(--v2-ink)]">{walletName}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-[var(--v2-ink-3)]">Approval</dt>
          <dd className="mt-1 text-[var(--v2-ink-2)]">Required above budget</dd>
        </div>
      </dl>

      {children && (
        <div className={`${compact ? 'mt-3 pt-3' : 'mt-4 pt-4'} border-t border-[var(--v2-border)]`}>
          {children}
        </div>
      )}
    </Card>
  )
}
