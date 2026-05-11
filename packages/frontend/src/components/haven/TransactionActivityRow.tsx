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
          {timestamp || action ? (
            <div className="mt-1 flex items-center justify-end gap-2 text-xs text-[var(--v2-ink-3)]">
              {timestamp ? <span>{timestamp}</span> : null}
              {action}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export function ExternalDetailsLink({ href, label = 'Open externally' }: { href: string; label?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
    >
      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H18m0 0v4.5M18 6l-7.5 7.5M10.5 6H6.75A2.25 2.25 0 004.5 8.25v9A2.25 2.25 0 006.75 19.5h9A2.25 2.25 0 0018 17.25V13.5" />
      </svg>
    </a>
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
