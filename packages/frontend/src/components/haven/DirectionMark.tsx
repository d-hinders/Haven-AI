import { ArrowDown, ArrowUp, Clock } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import type { TransactionActivityDirection } from './TransactionActivityRow'

type Density = 'comfortable' | 'compact' | 'inline'

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
 * - `inline`: 18px mark, 11px icon — small enough to sit BESIDE a figure in
 *   dense content (the account summary card's Last 30 days row, #4197).
 *   Still `aria-hidden`: the name is the caller's sr-only text, and any
 *   tooltip lives on the mark through `ui/Tooltip`.
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
      ? 'border-success/20 bg-[var(--v2-success-soft)] text-[var(--v2-success)]'
      : direction === 'out'
        ? 'border-debit/20 bg-[var(--v2-debit-soft)] text-[var(--v2-debit)]'
        : 'border-[var(--v2-border)] bg-[var(--v2-surface-2)] text-[var(--v2-ink-3)]'

  // The radius scales with the mark (10px reads as a squircle at 32-36px but
  // near-circles an 18px mark), so it lives with the size, not in the base.
  const sizeClass =
    density === 'compact'
      ? 'h-8 w-8 rounded-[10px]'
      : density === 'inline'
        ? 'h-[18px] w-[18px] rounded-[6px]'
        : 'h-9 w-9 rounded-[10px]'
  const iconSizeClass =
    density === 'compact' ? 'h-3.5 w-3.5' : density === 'inline' ? 'h-[11px] w-[11px]' : 'h-4 w-4'

  return (
    <span
      aria-hidden="true"
      className={`flex flex-shrink-0 items-center justify-center border ${sizeClass} ${classes}`}
    >
      <Icon
        icon={direction === 'in' ? ArrowDown : direction === 'out' ? ArrowUp : Clock}
        className={iconSizeClass}
      />
    </span>
  )
}
