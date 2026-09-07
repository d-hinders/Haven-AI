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
   * `compact` is the dashboard preview, tightened so the agents and
   * transactions columns sit on the same rhythm. Compact also hides the
   * description line on the desktop layout.
   *
   * This used to say compact "matches the height of the shared `<Row>`
   * primitive (~56px)", which was wrong twice over and about the one property
   * #1833 turned out to hinge on: compact is pinned to **72px** (at `sm` and
   * up — see `containerPadding`), and 56px is `Row`'s *comfortable* density,
   * its compact being ~44px (`ui/Row.tsx`). Corrected rather than left, since
   * a stale number about row height is exactly what sends the next reader to
   * the wrong conclusion here.
   */
  density?: Density
}) {
  const isCompact = density === 'compact'
  // Compact density pins the row to 72px so the dashboard's agents and
  // transactions columns sit on identical rhythm regardless of line-height
  // nuances inside the title row (badge + text mixed heights).
  //
  // The pin is `sm:` ONLY, and the breakpoint is the whole point (#1833). The
  // height was measured against the two-column arrangement below
  // (`sm:grid-cols-[minmax(0,1fr)_auto]`), which does not exist under 640px:
  // there the two children STACK, so title+description and amount+timestamp
  // occupy two bands inside a box still clamped to 72px, and the overflow
  // spilled onto the following row. Rows visibly overlapped on /dashboard at
  // 390px — found independently by two rendered review passes, neither
  // looking for it.
  //
  // Below `sm` the row therefore sizes to its content, with `py-3` supplying
  // the vertical breathing room the fixed height used to provide. At `sm` and
  // up `sm:py-0` hands it back, so the desktop rhythm this pin exists for is
  // byte-identical to before.
  //
  // Sizing to content rather than raising the number on purpose: the content
  // is variable-height (a wrapping <TransactionMovement>, an optional status
  // badge), so any fixed value is a new overlap waiting for the first string
  // long enough to exceed it.
  const containerPadding = isCompact
    ? 'gap-3 px-4 py-3 sm:px-5 sm:py-0 sm:h-[72px]'
    : 'gap-3 px-4 py-4 sm:px-5'
  return (
    <div className={`grid transition-colors hover:bg-[var(--v2-surface-hover)] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center ${containerPadding}`}>
      {/* `items-start` below `sm`, centred at `sm` and up (#1833 review).
          Centring the mark against the WHOLE text block reads correctly while
          that block is one or two lines, and wrongly once it wraps to three or
          four: the mark drifts down beside the status badge or the "From …"
          line, away from the title it marks. Below `sm` that wrap is now the
          common case rather than the exception, because the row sizes to its
          content instead of clipping at 72px — so this fix and the height fix
          are the same change seen from two sides.

          Same shape as the height pin above: an alignment chosen for the
          arrangement at one breakpoint, applied where that arrangement does
          not exist. `sm:items-center` keeps `sm`+ byte-identical. */}
      <div className="flex min-w-0 items-start gap-3 sm:items-center">
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
  // Keep the table's 24px visual column while extending the clickable area
  // to 44px. Giving the anchor a min-width would steal space from the
  // activity title at the md breakpoint and reintroduce #1827's wrap.
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      className="relative inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 after:absolute after:left-1/2 after:top-1/2 after:h-11 after:w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']"
    >
      <Icon icon={ExternalLink} className="h-3.5 w-3.5" />
    </a>
  )
}
