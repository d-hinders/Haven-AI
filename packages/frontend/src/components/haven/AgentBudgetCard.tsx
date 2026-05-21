import type { ReactNode } from 'react'
import { Card } from '@/components/ui/Card'
import { StatusBadge } from '@/components/ui/StatusBadge'

export type AgentBudgetRow = {
  id?: string
  tokenSymbol: string
  amount: string
  period: string
}

export function AgentBudgetCard({
  agentName,
  budgets,
  walletName,
  status = 'Draft',
  statusTone = 'brand',
  density = 'normal',
  onRemoveBudget,
  emptyLabel = 'No budget set yet',
  children,
}: {
  agentName: string
  budgets: AgentBudgetRow[]
  walletName?: string
  status?: string
  statusTone?: 'success' | 'warning' | 'danger' | 'neutral' | 'brand'
  density?: 'normal' | 'compact'
  onRemoveBudget?: (row: AgentBudgetRow) => void
  emptyLabel?: string
  children?: ReactNode
}) {
  const compact = density === 'compact'
  const isEmpty = budgets.length === 0

  return (
    <Card hover={false} className={compact ? 'p-3' : 'p-5'}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-[var(--v2-ink-3)]">Agent budget</p>
          <h3 className={`${compact ? 'mt-0.5 text-sm' : 'mt-1 text-base'} font-semibold text-[var(--v2-ink)]`}>
            {agentName}
          </h3>
        </div>
        <StatusBadge tone={statusTone}>{status}</StatusBadge>
      </div>

      <div className={`${compact ? 'mt-2 space-y-1.5' : 'mt-4 space-y-2'}`}>
        {isEmpty ? (
          <div
            className={`flex items-center justify-center rounded-lg border border-dashed border-[var(--v2-border)] bg-[var(--v2-surface)] ${compact ? 'px-3 py-2 text-xs' : 'px-3 py-3 text-sm'} text-[var(--v2-ink-3)]`}
          >
            {emptyLabel}
          </div>
        ) : (
          budgets.map((row) => (
            <div
              key={row.id ?? row.tokenSymbol}
              className="flex items-center justify-between gap-3 rounded-lg border border-[var(--v2-border)] bg-white px-3 py-2"
            >
              <p className={`${compact ? 'text-sm' : 'text-sm'} min-w-0 truncate font-medium text-[var(--v2-ink)] v2-tabular`}>
                {row.amount} {row.tokenSymbol}
              </p>
              <div className="flex flex-shrink-0 items-center gap-2">
                <p className="text-xs text-[var(--v2-ink-2)]">{row.period}</p>
                {onRemoveBudget && (
                  <button
                    type="button"
                    onClick={() => onRemoveBudget(row)}
                    aria-label={`Remove ${row.tokenSymbol} budget`}
                    className="rounded-md p-1 text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-danger-soft)] hover:text-[var(--v2-danger)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14H6L5 6" />
                      <path d="M10 11v6M14 11v6" />
                      <path d="M9 6V4h6v2" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {walletName && (
        <p className={`${compact ? 'mt-2 text-xs' : 'mt-3 text-xs'} text-[var(--v2-ink-2)]`}>
          <span className="text-[var(--v2-ink-3)]">From wallet:</span>{' '}
          <span className="font-medium text-[var(--v2-ink)]">{walletName}</span>
        </p>
      )}

      {children && (
        <div className={`${compact ? 'mt-2 pt-2' : 'mt-4 pt-4'} border-t border-[var(--v2-border)]`}>
          {children}
        </div>
      )}
    </Card>
  )
}
