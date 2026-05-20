import type { TransactionActivityDirection } from './TransactionActivityRow'

type Density = 'comfortable' | 'compact'

/**
 * Single source of truth for the in/out/pending direction icon used in
 * transaction rows. Previously each table inlined its own copy; this lifts
 * the markup so a colour change (e.g. the sky-blue debit colour for
 * outgoing transactions) lands everywhere at once.
 *
 * - `comfortable` (default): 36px mark, 16px icon — used inside the
 *   dedicated `/transactions` table.
 * - `compact`: 32px mark, 14px icon — matches the dashboard's <Row>
 *   primitive so transaction rows sit on the same rhythm as agent rows.
 */
export function DirectionMark({
  direction,
  density = 'comfortable',
}: {
  direction: TransactionActivityDirection
  density?: Density
}) {
  const classes =
    direction === 'in'
      ? 'border-[var(--v2-success)]/20 bg-[var(--v2-success-soft)] text-[var(--v2-success)]'
      : direction === 'out'
        ? 'border-[var(--v2-debit)]/20 bg-[var(--v2-debit-soft)] text-[var(--v2-debit)]'
        : 'border-[var(--v2-border)] bg-[var(--v2-surface-2)] text-[var(--v2-ink-3)]'

  const sizeClass = density === 'compact' ? 'h-8 w-8' : 'h-9 w-9'
  const iconSizeClass = density === 'compact' ? 'h-3.5 w-3.5' : 'h-4 w-4'

  return (
    <span
      aria-hidden="true"
      className={`flex flex-shrink-0 items-center justify-center rounded-[10px] border ${sizeClass} ${classes}`}
    >
      <svg className={iconSizeClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        {direction === 'in' ? (
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14m0 0l-5-5m5 5l5-5" />
        ) : direction === 'out' ? (
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5m0 0l-5 5m5-5l5 5" />
        ) : (
          <>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l2.5 2.5" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </>
        )}
      </svg>
    </span>
  )
}
