import type { ReactNode } from 'react'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Amount, type AmountCurrency } from './Amount'
import { DirectionMark } from './DirectionMark'
import { ExternalLink } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'

type StatusTone = 'success' | 'warning' | 'danger' | 'neutral' | 'brand'
export type TransactionActivityDirection = 'in' | 'out' | 'neutral' | 'move'
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
  extraBadges,
  timestamp,
  direction = 'neutral',
  details = [],
  action,
  density = 'comfortable',
  countLabel,
  fiat,
  onOpen,
  insetDivider = false,
}: {
  title: string
  description?: ReactNode
  /**
   * Token mode: a formatted, unsigned amount — sign and tone come from
   * `direction`/`failed` via <Amount>. `fiat` (below) takes precedence when
   * present; the two modes are mutually exclusive by construction.
   */
  value: string
  /** Optional group-count marker (#3810): a muted "×N" beside the title. */
  countLabel?: string
  /**
   * Currency mode (#3805, #3810): the row's figure is ALREADY a fiat
   * valuation server-side (book-time `convertedAmount`, or #3824's
   * `approxAmount`), so the amount renders through <Amount>'s currency mode —
   * an em dash for an unknown valuation, and `approx` as the caller's
   * `shouldMarkApprox` answer for a row, which is never a mark (#4165). Omitted for
   * token-denominated rows (rows that show the token amount) — the default keeps every
   * existing caller byte-identical.
   */
  fiat?: { amount: number | null; currency: AmountCurrency; approx?: boolean }
  asset?: string
  failed?: boolean
  status?: string
  statusTone?: StatusTone
  /**
   * Badges after the status badge, on the same wrapping title line (#4266):
   * the `/transactions` ledger's per-payment `AccountingBadge`, as a plain
   * pill (`interactive={false}`) — a control nested in the row button is
   * invalid ARIA.
   */
  extraBadges?: ReactNode
  timestamp?: string
  direction?: TransactionActivityDirection
  details?: TransactionActivityDetail[]
  action?: ReactNode
  /**
   * `comfortable` (default) is the roomier row. `compact` is used by the
   * dashboard preview and by the ledgers (/transactions, the account and agent
   * Activity tabs) — tightened so the dashboard's agents and
   * transactions columns sit on the same rhythm. Compact truncates the
   * description line to one line rather than hiding it — the ledgers' subline
   * (who acted, the account) relies on it showing.
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
  /**
   * Ledger mode (#4096, epic #4093): when provided, the whole row is a
   * button — click or Enter/Space calls it — so a full ledger (one row per
   * transaction, grouped under day headers) can open the shared
   * `TransactionDetailPanel` from the row itself, the way the transactions
   * table's title button opens it. Omitted (default) in the merged
   * dashboard preview, where the whole list is one link and rows carry no
   * interaction of their own.
   */
  onOpen?: () => void
  /**
   * Same-day divider (#4165, owner decision 2026-10-20 on #4093): a hairline
   * in `--v2-border-subtle` along the row's top edge, inset to start at the
   * text column (after the direction mark) and end at the row's padding. A
   * ledger passes it for every row after the first in a day group; the day
   * groups themselves keep their full-width `--v2-border` separation.
   */
  insetDivider?: boolean
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
  // The inset is the row's own geometry — padding, the mark (32px compact,
  // 36px comfortable) and the 12px gap — so the hairline starts exactly where
  // the title does at every breakpoint.
  const dividerClass = insetDivider
    ? ` before:pointer-events-none before:absolute before:top-0 before:h-px before:bg-[var(--v2-border-subtle)] before:content-[''] before:right-4 sm:before:right-5 ${
        isCompact ? 'before:left-[60px] sm:before:left-[64px]' : 'before:left-[64px] sm:before:left-[68px]'
      }`
    : ''
  const containerPadding = isCompact
    ? 'gap-3 px-4 py-3 sm:px-5 sm:py-0 sm:h-[72px]'
    : 'gap-3 px-4 py-4 sm:px-5'
  // Ledger mode (#4096): the row itself is the control — a div carrying
  // button semantics. A ledger row must contain no controls (design-system
  // § Transaction ledger, #4266): a control nested in a button is invalid
  // ARIA. Enter and Space activate, per the button role.
  const interactiveProps = onOpen
    ? {
        role: 'button' as const,
        tabIndex: 0,
        'aria-haspopup': 'dialog' as const,
        onClick: () => onOpen(),
        onKeyDown: (event: React.KeyboardEvent) => {
          // Only the row's own key presses (#4266) — defensive: nothing inside
          // a ledger row should take focus, but a key press that does arrive
          // from a descendant must not also open the panel.
          if (event.target !== event.currentTarget) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onOpen()
          }
        },
      }
    : {}
  return (
    <div
      {...interactiveProps}
      data-inset-divider={insetDivider ? '' : undefined}
      className={`relative grid transition-colors hover:bg-[var(--v2-surface-hover)] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center ${containerPadding}${dividerClass}${onOpen ? ' cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/80' : ''}`}
    >
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
            {countLabel ? (
              <span className="text-xs font-medium text-[var(--v2-ink-3)]">{countLabel}</span>
            ) : null}
            {status ? <StatusBadge tone={statusTone}>{status}</StatusBadge> : null}
            {extraBadges}
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
            {fiat ? (
              <Amount
                amount={fiat.amount}
                currency={fiat.currency}
                approx={fiat.approx}
                direction={direction === 'neutral' || direction === 'move' ? undefined : direction}
                failed={failed}
              />
            ) : (
              <Amount
                value={value}
                symbol={asset}
                direction={direction === 'neutral' || direction === 'move' ? undefined : direction}
                failed={failed}
              />
            )}
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

// ── Ledger mode: day grouping (#4096, epic #4093) ───────────────────────────

/**
 * Local calendar day of an ISO instant, `YYYY-MM-DD` (en-CA's ISO format) —
 * the same key the dashboard's ActivitySection buckets its groups by.
 */
export function transactionDayKey(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso))
}

/**
 * Heading for a day bucket: "Today", "Yesterday", else the short date
 * ("17 May"). Derived from the DAY KEY, not re-derived from a raw instant,
 * so a row rendered under "Today" IS from today — the label and the bucket
 * cannot drift apart the way a label recomputed from the timestamp could
 * across midnight (the #3810 rule, now shared).
 */
export function transactionDayLabel(dayKey: string): string {
  const today = new Date()
  const localDay = (date: Date) =>
    new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date)
  if (dayKey === localDay(today)) return 'Today'
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (dayKey === localDay(yesterday)) return 'Yesterday'
  const [year, month, day] = dayKey.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  return new Intl.DateTimeFormat('en-GB', { month: 'short', day: 'numeric' }).format(date)
}

export interface TransactionDayGroup<T> {
  /** The bucket's local-day key (`YYYY-MM-DD`). */
  dayKey: string
  /** The rendered heading ("Today", "Yesterday", "17 May"). */
  label: string
  /** The items in this day, in the order the caller supplied them. */
  items: T[]
}

/**
 * Bucket a ledger's transactions into day groups, one row per transaction
 * under each header (#4096) — the un-merged counterpart of the dashboard's
 * ActivitySection grouping, which folds same-agent/same-merchant/same-day
 * into one "×N" row. Days come out in the order first seen (the feed is
 * newest-first, so that is newest day first); within a day the caller's
 * order stands. `timestampOf` keeps the helper generic: the ledger mode
 * serves whatever the caller's rows are (AggregatedTransaction on the
 * account page), and the helper never needs their shape.
 */
export function transactionDayGroups<T>(
  items: readonly T[],
  timestampOf: (item: T) => string,
): Array<TransactionDayGroup<T>> {
  const buckets = new Map<string, T[]>()
  for (const item of items) {
    const key = transactionDayKey(timestampOf(item))
    const bucket = buckets.get(key)
    if (bucket) bucket.push(item)
    else buckets.set(key, [item])
  }
  return Array.from(buckets.entries(), ([dayKey, groupItems]) => ({
    dayKey,
    label: transactionDayLabel(dayKey),
    items: groupItems,
  }))
}

/**
 * A ledger's day-group heading — the tinted day band, the second sanctioned
 * band after `Card.Header` (owner decision on #4225, 2026-10-21). Built on
 * the table-header tokens (`--v2-table-header-bg` / `--v2-table-header-ink`,
 * the same values as `--v2-surface`) with a full-width hairline below; the
 * label is uppercased by CSS (`text-transform`, never `toUpperCase()`, so
 * DOM text keeps matching "Today"). Every list that groups by day bands its
 * headings — except the dashboard's first day, where the Activity card's own
 * tinted `Card.Header` sits directly above and `band={false}` keeps today's
 * plain label so two bands of one tint never stack.
 *
 * `partial` marks a bucket whose day is cut by a window boundary (the #3975
 * analytics rule) as "(partial)".
 */
export function TransactionActivityDayHeader({
  label,
  partial = false,
  band = true,
}: {
  label: string
  partial?: boolean
  /** The tinted band; `false` keeps the pre-#4225 plain label (dashboard's first day). */
  band?: boolean
}) {
  return (
    <p
      className={
        band
          ? 'border-b border-[var(--v2-border)] bg-[var(--v2-table-header-bg)] px-4 pt-3 pb-1 text-xs font-medium uppercase tracking-wider text-[var(--v2-table-header-ink)] sm:px-5'
          : 'px-4 pt-3 pb-1 text-xs font-medium text-[var(--v2-ink-3)] sm:px-5'
      }
    >
      {partial ? `${label} (partial)` : label}
    </p>
  )
}
