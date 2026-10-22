'use client'

/**
 * Per-transaction accounting badge (#2870, epic #2858 slice 12).
 *
 * Shows the feed's state for ONE payment where the user already looks — the
 * `/transactions` ledger row (#4266) and the detail drawer. In the drawer it
 * links to `/accounting`, where the row can be re-synced or checked against
 * the provider, and carries the failure reason on hover/focus; on a ledger row
 * it is the plain pill (`interactive={false}`) — the row is itself a button. Reads the
 * `accounting` object the list endpoint joins per row; renders nothing when
 * it is absent, which is how the backend says "feature off, no connection,
 * or this payment was never fed" (the absence is the contract, not a null).
 *
 * Three states, one label each:
 *   pushed          → "In <Provider>", or "Evidence archived" for a
 *                     record-only connector (#3018: Accounted archives the
 *                     document Haven pushed — "In …" would read as a booking
 *                     the provider made)
 *   pending         → "Feeding…"       (neutral — in flight)
 *   failed/skipped  → "Not fed"        (warning), the reason on hover/focus
 *                                      where the badge is interactive
 *
 * No "Booked in <Provider>" state: the ledger stores no verify result, so the
 * list cannot say it truthfully. The `/accounting` page's live read-back is
 * where booking is answered.
 *
 * The provider name comes from the row (`accounting.provider`), through a
 * small display map, so a second provider does not read as "In Fortnox".
 */
import Link from 'next/link'
import type { MouseEvent } from 'react'
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
  accounted: 'Accounted',
}

export function providerDisplayName(provider: string): string {
  const known = PROVIDER_NAMES[provider.toLowerCase()]
  if (known) return known
  return provider.length === 0 ? provider : provider[0].toUpperCase() + provider.slice(1)
}

/**
 * Providers whose descriptor declares `capabilities.verify: false` (#3018):
 * their pushed record is a document Haven archived, verify answers from
 * Haven's own record, and user-facing copy must not read as a provider
 * read-back. The badge's pushed label and the feed page's verify sentences
 * both branch on this — one decision, one home.
 */
export const RECORD_ONLY_PROVIDERS = new Set(['accounted'])

const TONE: Record<TransactionAccounting['status'], StatusTone> = {
  pushed: 'success',
  pending: 'neutral',
  failed: 'warning',
  skipped: 'warning',
}

/**
 * Defensive: should the link form ever sit inside something clickable, the
 * click must stop here, and not only for the mouse: Enter on an `<a>` fires
 * a synthetic click that bubbles to the parent's `onClick`. A ledger row
 * (a whole-row `role="button"`) never gets the link form — it passes
 * `interactive={false}` (#4266), because a control inside a button is
 * invalid ARIA.
 */
function stopRowActivation(event: MouseEvent) {
  event.stopPropagation()
}

export interface AccountingBadgeProps {
  accounting?: TransactionAccounting | null
  className?: string
  /**
   * `false` renders the pill alone — no link to `/accounting`, no reason
   * tooltip — for a host that is itself the control: the `/transactions`
   * ledger row is a whole-row `role="button"`, and a link nested inside it
   * is invalid ARIA (#4266). The row opens `TransactionDetailPanel`, whose
   * Feed row carries the linked badge and the reason.
   */
  interactive?: boolean
}

/**
 * The hidden state is decided BEFORE any hook runs: the catalog hook needs
 * `LocaleProvider`, and a row without `accounting` must cost nothing — not a
 * provider lookup, not a render — wherever the ledger is mounted.
 */
export function AccountingBadge({ accounting, className = '', interactive = true }: AccountingBadgeProps) {
  if (!accounting) return null
  return <PresentAccountingBadge accounting={accounting} className={className} interactive={interactive} />
}

function PresentAccountingBadge({
  accounting,
  className,
  interactive,
}: {
  accounting: TransactionAccounting
  className: string
  interactive: boolean
}) {
  const t = useT()

  const label =
    accounting.status === 'pushed'
      ? RECORD_ONLY_PROVIDERS.has(accounting.provider.toLowerCase())
        ? t.accountingBadge.evidenceArchived
        : t.accountingBadge.inProvider(providerDisplayName(accounting.provider))
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

  if (!interactive) {
    return (
      <span
        className={`inline-flex ${className}`}
        data-testid="accounting-badge"
        data-status={accounting.status}
      >
        <StatusBadge tone={TONE[accounting.status]}>{label}</StatusBadge>
      </span>
    )
  }

  const link = (
    <Link
      href={ACCOUNTING_PAGE_HREF}
      aria-label={t.accountingBadge.openAccounting(label)}
      onClick={stopRowActivation}
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
