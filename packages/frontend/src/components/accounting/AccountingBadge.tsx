'use client'

/**
 * Per-transaction accounting badge (#2870, epic #2858 slice 12).
 *
 * Shows the feed's state for ONE payment where the user already looks — the
 * Transactions table row and the detail drawer — and links to `/accounting`,
 * where the row can be re-synced or checked against the provider. Reads the
 * `accounting` object the list endpoint joins per row; renders nothing when
 * it is absent, which is how the backend says "feature off, no connection,
 * or this payment was never fed" (the absence is the contract, not a null).
 *
 * Three states, one label each:
 *   pushed          → "In <Provider>"  (success)
 *   pending         → "Feeding…"       (neutral — in flight)
 *   failed/skipped  → "Not fed"        (warning), the reason on hover/focus
 *
 * No "Booked in <Provider>" state: the ledger stores no verify result, so the
 * list cannot say it truthfully. The `/accounting` page's live read-back is
 * where booking is answered.
 *
 * The provider name comes from the row (`accounting.provider`), through a
 * small display map, so a second provider does not read as "In Fortnox".
 */
import Link from 'next/link'
import type { KeyboardEvent, MouseEvent } from 'react'
import type { ApiSchema } from '@haven_ai/core'
import { useT } from '@/context/LocaleContext'
import { StatusBadge, type StatusTone } from '@/components/ui/StatusBadge'
import { Tooltip } from '@/components/ui/Tooltip'

export type TransactionAccounting = ApiSchema<'TransactionAccounting'>

/** Where the badge sends the user — the feed's own page. */
export const ACCOUNTING_PAGE_HREF = '/accounting'

/** Ledger provider key → display name. Anything unmapped is capitalised. */
const PROVIDER_NAMES: Record<string, string> = {
  fortnox: 'Fortnox',
}

export function providerDisplayName(provider: string): string {
  const known = PROVIDER_NAMES[provider.toLowerCase()]
  if (known) return known
  return provider.length === 0 ? provider : provider[0].toUpperCase() + provider.slice(1)
}

const TONE: Record<TransactionAccounting['status'], StatusTone> = {
  pushed: 'success',
  pending: 'neutral',
  failed: 'warning',
  skipped: 'warning',
}

/**
 * The badge sits inside a row that is itself a `role="button"` (the table
 * row opens the detail drawer on click AND on Enter/Space). Both must stop
 * here: a click that bubbles opens the drawer under the navigation, and the
 * row's keydown handler calls `preventDefault()` on Enter, which would cancel
 * the link's own activation.
 */
function stopRowActivation(event: MouseEvent | KeyboardEvent) {
  event.stopPropagation()
}

export interface AccountingBadgeProps {
  accounting?: TransactionAccounting | null
  className?: string
}

/**
 * The hidden state is decided BEFORE any hook runs: the catalog hook needs
 * `LocaleProvider`, and a row without `accounting` must cost nothing — not a
 * provider lookup, not a render — wherever the table is mounted.
 */
export function AccountingBadge({ accounting, className = '' }: AccountingBadgeProps) {
  if (!accounting) return null
  return <PresentAccountingBadge accounting={accounting} className={className} />
}

function PresentAccountingBadge({
  accounting,
  className,
}: {
  accounting: TransactionAccounting
  className: string
}) {
  const t = useT()

  const label =
    accounting.status === 'pushed'
      ? t.accountingBadge.inProvider(providerDisplayName(accounting.provider))
      : accounting.status === 'pending'
        ? t.accountingBadge.feeding
        : t.accountingBadge.notFed

  // The reason is elaboration on a visible label, which is what `Tooltip` is
  // for (#2038) — the label itself already says the payment was not fed, so
  // nothing essential is hover-only. Only the failed/skipped states carry one;
  // a pushed row's `error` is the #498 non-fatal note and not a failure.
  const reason =
    (accounting.status === 'failed' || accounting.status === 'skipped') && accounting.error
      ? accounting.error
      : null

  const link = (
    <Link
      href={ACCOUNTING_PAGE_HREF}
      aria-label={t.accountingBadge.openAccounting(label)}
      onClick={stopRowActivation}
      onKeyDown={stopRowActivation}
      className={`inline-flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 ${className}`}
      data-testid="accounting-badge"
      data-status={accounting.status}
    >
      <StatusBadge tone={TONE[accounting.status]}>{label}</StatusBadge>
    </Link>
  )

  return reason ? <Tooltip label={reason}>{link}</Tooltip> : link
}

export default AccountingBadge
