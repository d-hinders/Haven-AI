import type { ReactNode } from 'react'
import { StatusBadge } from '@/components/ui/StatusBadge'

type StatusTone = 'success' | 'warning' | 'danger' | 'neutral' | 'brand'
type AmountTone = 'success' | 'danger' | 'neutral'
type Direction = 'in' | 'out' | 'neutral'

export interface TransactionActivityDetail {
  label: string
  value: ReactNode
}

const AMOUNT_TONE_CLASS: Record<AmountTone, string> = {
  success: 'text-[var(--v2-success)]',
  danger: 'text-[var(--v2-danger)]',
  neutral: 'text-[var(--v2-ink)]',
}

export function TransactionActivityRow({
  title,
  description,
  amount,
  amountTone = 'neutral',
  status,
  statusTone = 'neutral',
  timestamp,
  direction = 'neutral',
  details = [],
  action,
}: {
  title: string
  description?: ReactNode
  amount: string
  amountTone?: AmountTone
  status?: string
  statusTone?: StatusTone
  timestamp?: string
  direction?: Direction
  details?: TransactionActivityDetail[]
  action?: ReactNode
}) {
  return (
    <div className="grid gap-3 px-4 py-4 transition-colors hover:bg-[var(--v2-surface)] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5">
      <div className="flex min-w-0 items-start gap-3">
        <DirectionMark direction={direction} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 truncate text-sm font-medium text-[var(--v2-ink)]">{title}</p>
            {status ? <StatusBadge tone={statusTone}>{status}</StatusBadge> : null}
          </div>
          {description ? (
            <div className="mt-1 text-xs text-[var(--v2-ink-2)]">{description}</div>
          ) : null}
          {details.length > 0 ? (
            <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--v2-ink-3)]">
              {details.map((detail) => (
                <div key={detail.label} className="flex min-w-0 items-center gap-1">
                  <dt className="flex-shrink-0">{detail.label}:</dt>
                  <dd className="min-w-0 truncate text-[var(--v2-ink-2)]">{detail.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 pl-11 sm:block sm:pl-0 sm:text-right">
        <div>
          <p className={`text-sm font-semibold v2-tabular ${AMOUNT_TONE_CLASS[amountTone]}`}>
            {amount}
          </p>
          {timestamp ? <p className="mt-1 text-xs text-[var(--v2-ink-3)]">{timestamp}</p> : null}
        </div>
        {action ? <div className="flex-shrink-0 sm:mt-1">{action}</div> : null}
      </div>
    </div>
  )
}

function DirectionMark({ direction }: { direction: Direction }) {
  const classes =
    direction === 'in'
      ? 'border-[var(--v2-success)]/20 bg-[var(--v2-success-soft)] text-[var(--v2-success)]'
      : direction === 'out'
        ? 'border-[var(--v2-border)] bg-[var(--v2-surface-2)] text-[var(--v2-ink-2)]'
        : 'border-[var(--v2-border)] bg-[var(--v2-surface-2)] text-[var(--v2-ink-3)]'

  return (
    <span
      aria-hidden="true"
      className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[10px] border ${classes}`}
    >
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        {direction === 'in' ? (
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14m0 0l-5-5m5 5l5-5" />
        ) : direction === 'out' ? (
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5m0 0l-5 5m5-5l5 5" />
        ) : (
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l2.5 2.5" />
        )}
      </svg>
    </span>
  )
}
