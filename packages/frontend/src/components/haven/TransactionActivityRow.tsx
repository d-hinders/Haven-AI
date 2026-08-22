import type { ReactNode } from 'react'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Amount } from './Amount'
import { DirectionMark } from './DirectionMark'
import { ExternalLink } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'

type StatusTone = 'success' | 'warning' | 'danger' | 'neutral' | 'brand'
export type TransactionActivityDirection = 'in' | 'out' | 'neutral'
type Density = 'comfortable' | 'compact'

export interface TransactionActivityDetail {
  label: string
  value: ReactNode
}

export function TransactionActivityRow({
  title,
  description,
  value,
  asset,
  failed = false,
  status,
  statusTone = 'neutral',
  timestamp,
  direction = 'neutral',
  details = [],
  action,
  density = 'comfortable',
}: {
  title: string
  description?: ReactNode
  /** Formatted, unsigned amount — sign and tone come from `direction`/`failed` via <Amount>. */
  value: string
  asset?: string
  failed?: boolean
  status?: string
  statusTone?: StatusTone
  timestamp?: string
  direction?: TransactionActivityDirection
  details?: TransactionActivityDetail[]
  action?: ReactNode
  /**
   * `comfortable` (default) is for the dedicated transactions screen.
   * `compact` matches the height of the shared `<Row>` primitive (~56px) so
   * the dashboard's agents + transactions columns sit on the same rhythm.
   * Compact also hides the description line on the desktop layout.
   */
  density?: Density
}) {
  const isCompact = density === 'compact'
  // Compact density pins to a fixed row height (h-[72px]) so the dashboard's
  // agents and transactions columns sit on identical rhythm regardless of
  // line-height nuances inside the title row (badge + text mixed heights).
  // Horizontal padding only — vertical centering does the rest.
  const containerPadding = isCompact
    ? 'gap-3 px-4 sm:px-5 h-[72px]'
    : 'gap-3 px-4 py-4 sm:px-5'
  return (
    <div className={`grid transition-colors hover:bg-[var(--v2-surface-hover)] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center ${containerPadding}`}>
      <div className="flex min-w-0 items-center gap-3">
        <DirectionMark direction={direction} density={density} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 truncate text-sm font-medium text-[var(--v2-ink)]">{title}</p>
            {status ? <StatusBadge tone={statusTone}>{status}</StatusBadge> : null}
          </div>
          {description ? (
            // Compact density tightens the title→description gap to match Row's mt-0.5.
            <div className={`${isCompact ? 'mt-0.5 truncate' : 'mt-1'} text-xs text-[var(--v2-ink-2)]`}>{description}</div>
          ) : null}
          {details.length > 0 && !isCompact ? (
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
          <p>
            <Amount
              value={value}
              symbol={asset}
              direction={direction === 'neutral' ? undefined : direction}
              failed={failed}
            />
          </p>
          {(timestamp || action) && !isCompact ? (
            <div className="mt-1 flex items-center justify-end gap-2 text-xs text-[var(--v2-ink-3)]">
              {timestamp ? <span>{timestamp}</span> : null}
              {action}
            </div>
          ) : timestamp && isCompact ? (
            <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]">{timestamp}</p>
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
      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
    >
      <Icon icon={ExternalLink} className="h-3.5 w-3.5" />
    </a>
  )
}

