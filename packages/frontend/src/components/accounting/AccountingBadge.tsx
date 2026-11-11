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
 * Three states, one label each (#4567 — the vocabulary table in
 * `docs/product/design-system.md` § StatusBadge is the source of truth):
 *   pushed          → "In <Provider>", or "Evidence archived" for a
 *                     record-only connector (#3018: Accounted archives the
 *                     document Haven pushed — "In …" would read as a booking
 *                     the provider made), or "Tracked" when the deployment's
 *                     live connector is not configured (SR:1583 — nothing
 *                     left Haven, so the row may not claim delivery)
 *   pending         → "Sending…"       (neutral — in flight)
 *   failed/skipped  → "Not sent"       (warning), the reason on hover/focus
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
import type { AccountingProvider } from '@/hooks/useAccounting'
import type { Messages } from '@/lib/i18n'
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
  igdrasil: 'Igdrasil',
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
 *
 * This set is the FALLBACK for callers that have no descriptor list to hand:
 * the ledger row and the detail drawer read only the row's `accounting`
 * object, so they cannot ask `GET /accounting/providers`. A caller that DOES
 * have the list (the `/accounting` page) passes it to
 * `isRecordOnlyProvider`, which prefers the descriptor — a connector that
 * flips `verify` then needs no edit here. Igdrasil is listed explicitly so
 * the badge is right before its descriptor lands (#4520).
 */
export const RECORD_ONLY_PROVIDERS = new Set(['accounted', 'igdrasil'])

/**
 * Is this provider record-only? The descriptor's `capabilities.verify` is the
 * source of truth when the caller has the provider list; otherwise the
 * explicit set above answers. A provider absent from a list that IS to hand
 * falls back to the set too — a partial list must not silently flip a
 * record-only connector back to "In <Provider>".
 */
export function isRecordOnlyProvider(
  provider: string,
  providers?: ReadonlyArray<Pick<AccountingProvider, 'id' | 'capabilities'>> | null,
): boolean {
  const id = provider.toLowerCase()
  const descriptor = providers?.find((p) => p.id.toLowerCase() === id)
  if (descriptor) return descriptor.capabilities.verify === false
  return RECORD_ONLY_PROVIDERS.has(id)
}

/**
 * The ONE label and tone for a feed row's state (#4567). Both surfaces that
 * render it — the per-payment badge and the `/accounting` page's row chip —
 * call this, so the two cannot drift; `lib/__tests__/status-vocabulary.test.ts`
 * holds it to the published table.
 *
 * Precedence, and why:
 *  1. A record-only connector's pushed row is "Evidence archived" whatever the
 *     deployment's live state — for Accounted/Igdrasil the archive IS the
 *     delivery, so the label stays true either way (#3018).
 *  2. A pushed row on a deployment whose live connector is not configured is
 *     "Tracked": the row exists in Haven, nothing left it (SR:1583).
 *  3. Otherwise a pushed row is "In <Provider>".
 *
 * `liveSyncReady` is optional because the ledger row and the detail drawer
 * read only the row's `accounting` object and have no feed status to consult;
 * absent means "not known to be a preview", which is the pre-#4567 answer.
 */
export function accountingStatusPresentation(
  accounting: Pick<TransactionAccounting, 'status' | 'provider'>,
  copy: Messages['accountingBadge'],
  options: {
    liveSyncReady?: boolean
    providers?: ReadonlyArray<Pick<AccountingProvider, 'id' | 'capabilities'>> | null
  } = {},
): { label: string; tone: StatusTone } {
  if (accounting.status === 'pushed') {
    if (isRecordOnlyProvider(accounting.provider, options.providers)) {
      return { label: copy.evidenceArchived, tone: 'success' }
    }
    if (options.liveSyncReady === false) {
      return { label: copy.tracked, tone: 'neutral' }
    }
    return { label: copy.inProvider(providerDisplayName(accounting.provider)), tone: 'success' }
  }
  if (accounting.status === 'pending') {
    return { label: copy.sending, tone: 'neutral' }
  }
  return { label: copy.notSent, tone: 'warning' }
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
   * Accounting row carries the linked badge, and its Reason row the reason.
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

  const { label, tone } = accountingStatusPresentation(accounting, t.accountingBadge)

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
        <StatusBadge tone={tone}>{label}</StatusBadge>
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
      <StatusBadge tone={tone}>{label}</StatusBadge>
    </Link>
  )

  return reason ? <Tooltip label={reason}>{link}</Tooltip> : link
}

export default AccountingBadge
