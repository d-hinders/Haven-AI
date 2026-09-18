'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  accountingFeedOffState,
  useAccountingFeed,
  type AccountingFeedStatus,
  type AccountingSyncStatus,
  type AccountingVerification,
} from '@/hooks/useAccountingFeed'
import { useT } from '@/context/LocaleContext'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { Skeleton } from '@/components/ui/Skeleton'
import { CONNECT_OUTCOME_PARAMS, readConnectOutcome } from '@/components/accounting/ConnectionsCard'
import { ComingSoon, SelfHostedUnavailable } from '@/components/accounting/ComingSoon'
import { ACCOUNTING_SETTINGS_HREF, FeedSummary } from '@/components/accounting/FeedSummary'
import { providerDisplayName, RECORD_ONLY_PROVIDERS } from '@/components/accounting/AccountingBadge'
import { truncate } from '@/lib/format'

/**
 * The OAuth callback still redirects here (`routes/accounting-connections.ts`
 * builds `${frontendUrl}/accounting?provider=…&connect=…`), but the
 * connection surface moved to Settings (#2868). Forward the outcome query
 * verbatim so the Settings card reads it — `connected` opens the backfill
 * choice there, `denied`/`error` (and `reason=unsupported_currency`) become
 * its sentence. Rendered inside `Suspense` because `useSearchParams` needs
 * a boundary on a prerendered page.
 */
function ConnectOutcomeForwarder() {
  const router = useRouter()
  const routerRef = useRef(router)
  routerRef.current = router
  const query = useSearchParams()?.toString() ?? ''
  useEffect(() => {
    const params = new URLSearchParams(query)
    if (!readConnectOutcome(params)) return
    const forwarded = new URLSearchParams()
    for (const key of CONNECT_OUTCOME_PARAMS) {
      const value = params.get(key)
      if (value) forwarded.set(key, value)
    }
    routerRef.current.replace(`${ACCOUNTING_SETTINGS_HREF}?${forwarded.toString()}`)
  }, [query])
  return null
}

const STATUS: Record<AccountingSyncStatus, { label: string; cls: string }> = {
  pushed: { label: 'Synced', cls: 'bg-[var(--v2-success-soft)] text-[var(--v2-success)]' },
  pending: { label: 'Pending', cls: 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-2)]' },
  failed: { label: 'Failed', cls: 'bg-[var(--v2-danger-soft)] text-[var(--v2-danger)]' },
  skipped: { label: 'Skipped', cls: 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-3)]' },
}

/** Same tone convention as `ui/Row`'s leadingTone — text-color variant (#1364 review). */
const TONE_TEXT: Record<'success' | 'warning' | 'danger', string> = {
  success: 'text-[var(--v2-success)]',
  warning: 'text-[var(--v2-warning)]',
  danger: 'text-[var(--v2-danger)]',
}

function StatusChip({ status }: { status: AccountingSyncStatus }) {
  const s = STATUS[status]
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>
}

/**
 * The retry-state counts (#2866) next to the list — over EVERY row, where
 * the list below is capped. `exhausted` is the one that needs the user
 * (the sweep has given up; "Sync now" re-claims it), so it is the only
 * count that changes tone.
 */
function FeedCounts({ counts }: { counts: AccountingFeedStatus['counts'] }) {
  const t = useT()
  const copy = t.accountingPage.counts
  const cells: Array<{ key: keyof typeof counts; label: string }> = [
    { key: 'pending', label: copy.pending },
    { key: 'failed', label: copy.failed },
    { key: 'exhausted', label: copy.exhausted },
  ]
  const exhausted = counts.exhausted > 0
  return (
    <div data-testid="feed-counts">
      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
        {cells.map(({ key, label }) => {
          const attention = key === 'exhausted' && exhausted
          return (
            <div key={key} className="flex items-center gap-1.5">
              <dt className="text-[var(--v2-ink-3)]">{label}</dt>
              <dd
                className={`v2-tabular font-semibold ${attention ? 'text-[var(--v2-warning)]' : 'text-[var(--v2-ink)]'}`}
                data-testid={`feed-count-${key}`}
              >
                {counts[key]}
              </dd>
            </div>
          )
        })}
      </dl>
      {/*
        The explanation is INLINE, and only when it applies (#2869 design
        review): a `title` is unreachable on touch and to a screen reader,
        and "Stopped retrying" is the one count that needs the user.
      */}
      {exhausted ? (
        <p className="mt-1 text-xs text-[var(--v2-warning)]" data-testid="feed-counts-exhausted-help">
          {copy.exhaustedHelp}
        </p>
      ) : null}
    </div>
  )
}

/** Nothing to count and nothing listed — the row would be three zeros over an empty list. */
function hasFeedActivity(status: Pick<AccountingFeedStatus, 'counts' | 'syncs'>): boolean {
  return status.syncs.length > 0 || Object.values(status.counts).some((n) => n > 0)
}

/**
 * The external_ref → the row's identity line + the key its verdict is bound
 * to (#1364), per provider (#3018). Fortnox carries an invoice number in its
 * ref; Accounted carries the document id. Null for any other namespace.
 */
function externalRecord(
  externalRef: string | null,
): { kind: 'invoice' | 'document'; id: string } | null {
  const invoice = externalRef?.match(/^fortnox:supplierinvoice:(\d+)$/)
  if (invoice) return { kind: 'invoice', id: invoice[1] }
  const document = externalRef?.match(/^accounted:document:([0-9a-fA-F-]{8,64})$/)
  if (document) return { kind: 'document', id: document[1] }
  return null
}

/**
 * Plain-language verdict from a verification (#1362), provider-conditional
 * since #3018. A provider that reads back (Fortnox) gets sentences naming
 * it and its invoice; a record-only provider (#3018, Accounted) answers
 * from Haven's own record, so its sentence says what Haven KNOWS — the
 * archived evidence and who books from it — and never reads as the
 * provider having answered. `registered: false` on a record-only row
 * (`foreign_invoice`) and `no_invoice_ref` keep the generic sentences:
 * they are about our own record's identity, not a provider verdict.
 */
function verificationSummary(
  v: AccountingVerification,
  provider: string,
  t: ReturnType<typeof useT>,
): { text: string; tone: 'success' | 'warning' | 'danger' } {
  if (RECORD_ONLY_PROVIDERS.has(provider)) {
    if (!v.registered) return { text: t.accountingPage.verify.foreign, tone: 'warning' }
    const document = v.document_ref ? v.document_ref.slice(0, 8) : null
    if (document) return { text: t.accountingPage.verify.accounted.registered(document), tone: 'success' }
    return { text: t.accountingPage.verify.missing, tone: 'warning' }
  }
  if (!v.registered) {
    return {
      text: t.accountingPage.verify.fortnox.deleted(String(v.invoice_number)),
      tone: 'danger',
    }
  }
  if (v.cancelled) {
    return { text: t.accountingPage.verify.fortnox.cancelled(String(v.invoice_number)), tone: 'warning' }
  }
  if (v.booked) {
    return {
      text: t.accountingPage.verify.fortnox.booked(
        String(v.invoice_number),
        v.voucher ?? '',
      ),
      tone: 'success',
    }
  }
  return {
    text: t.accountingPage.verify.fortnox.registered(String(v.invoice_number)),
    tone: 'success',
  }
}

export default function AccountingPage() {
  const t = useT()
  const { status, loading, error, sync, verify, reopen } = useAccountingFeed()
  const [busy, setBusy] = useState<'sync' | null>(null)
  const [verifying, setVerifying] = useState<string | null>(null)
  const [verifications, setVerifications] = useState<Record<string, AccountingVerification | { error: string }>>({})

  const runVerify = async (paymentId: string) => {
    setVerifying(paymentId)
    try {
      const v = await verify(paymentId)
      setVerifications((prev) => ({ ...prev, [paymentId]: v }))
    } catch (err) {
      // Surface the backend's actionable copy (e.g. "reconnect and try again")
      // instead of flattening every failure to one generic line (#1364 review).
      const message =
        err instanceof Error && err.message
          ? err.message
          : t.accountingPage.verify.checkFailed
      setVerifications((prev) => ({ ...prev, [paymentId]: { error: message } }))
    } finally {
      setVerifying(null)
    }
  }

  const run = async (kind: 'sync', fn: () => Promise<void>) => {
    setBusy(kind)
    try { await fn() } finally { setBusy(null) }
  }

  // #1376 review: reopen refusals (e.g. the invoice actually still exists,
  // or the row raced) must SURFACE, not vanish as an unhandled rejection —
  // same error-into-the-verdict-slot pattern as runVerify.
  const runReopen = async (paymentId: string) => {
    setBusy('sync')
    try {
      await reopen(paymentId)
      setVerifications((prev) => {
        const next = { ...prev }
        delete next[paymentId] // the row left pushed — the old verdict is void
        return next
      })
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'Could not re-open right now. Try again in a moment.'
      setVerifications((prev) => ({ ...prev, [paymentId]: { error: message } }))
    } finally {
      setBusy(null)
    }
  }

  const forwarder = (
    <Suspense fallback={null}>
      <ConnectOutcomeForwarder />
    </Suspense>
  )

  // #2869 design review: the product subtitle ("…appears in your accounting
  // tool as draft transactions") sat directly above "Nothing can be connected
  // yet." / "Not available on self-hosted". The off states — and the two
  // renders before the status is known — get the neutral line; the product
  // sentence is shown only once the feed is on.
  const off = accountingFeedOffState(status)
  const header = (
    <PageHeader
      title={t.accountingPage.title}
      subtitle={status && !off ? t.accountingPage.subtitle : t.accountingPage.subtitleOff}
    />
  )

  if (loading) {
    return (
      <div className="max-w-3xl">
        {forwarder}
        {header}
        <Skeleton variant="text" className="h-5 w-64" />
      </div>
    )
  }

  if (!status) {
    return (
      <div className="max-w-3xl">
        {forwarder}
        {header}
        {error ? <p className="text-sm text-[var(--v2-danger)]">{error}</p> : null}
      </div>
    )
  }

  // #2869: the two OFF states, two copies (owner decision 2026-09-11).
  // `!hosted` is "not available on self-hosted" — checked FIRST, so a
  // self-hosted box can never read as coming soon; `hosted && !enabled` is
  // Coming soon, visible in production. Neither offers a connect or sync
  // control. The add-on card below is the third case: flag on, not entitled.
  if (off === 'self_hosted') {
    return (
      <div className="max-w-3xl">
        {forwarder}
        {header}
        <SelfHostedUnavailable />
      </div>
    )
  }
  if (off === 'coming_soon') {
    return (
      <div className="max-w-3xl">
        {forwarder}
        {header}
        <ComingSoon />
      </div>
    )
  }

  return (
    <div className="max-w-3xl">
      {forwarder}
      {header}

      {!status.available ? (
        <Card className="p-5" hover={false}>
          <h2 className="v2-text-h3 text-[var(--v2-ink)]">Available as an add-on</h2>
          <p className="mt-1 text-sm text-[var(--v2-ink-2)]">
            Automatic accounting sync is part of the hosted plan. Contact us to enable it for your account.
          </p>
        </Card>
      ) : (
        <div className="space-y-5">
          {!status.liveSyncReady && (
            <div
              role="status"
              className="rounded-[12px] border border-warning/20 bg-[var(--v2-warning-soft)] px-4 py-3"
            >
              <p className="text-sm font-medium text-[var(--v2-warning)]">{t.accountingPage.previewBanner.title}</p>
              <p className="mt-1 text-sm text-[var(--v2-ink-2)]">
                {t.accountingPage.previewBanner.body}
              </p>
            </div>
          )}

          {/*
            The connection summary line (#2869): where payments go right now,
            or the attention state with its way to Settings. Connect /
            Disconnect live in Settings (#2868); the feed below works off the
            active destination.
          */}
          <FeedSummary status={status} />

          <Card className="p-0" hover={false}>
            <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h2 className="v2-text-h3 text-[var(--v2-ink)]">Synced transactions</h2>
                <p className="mt-1 text-sm text-[var(--v2-ink-2)]">Drafts fed to your accounting tool. Failures retry on sync.</p>
                {hasFeedActivity(status) ? (
                  <div className="mt-2">
                    <FeedCounts counts={status.counts} />
                  </div>
                ) : null}
              </div>
              {/*
                Wrapped (#2869 design review): as a direct child of the
                `flex-col` header the button stretched full-width below `sm`
                while the other actions on the page stay content-width.
              */}
              <div className="shrink-0">
                <Button
                  variant="ghost"
                  onClick={() => run('sync', sync)}
                  disabled={busy !== null || !status.connected}
                >
                  {busy === 'sync' ? 'Syncing…' : 'Sync now'}
                </Button>
              </div>
            </div>

            {error ? (
              <div className="px-5 pb-5 text-sm text-[var(--v2-danger)]">{error}</div>
            ) : status.syncs.length === 0 ? (
              <div className="px-5 pb-5 text-sm text-[var(--v2-ink-3)]">
                Nothing synced yet. Settled agent payments will appear here automatically.
              </div>
            ) : (
              <Card.Section divided>
                {status.syncs.map((s) => {
                  const record = s.status === 'pushed' ? externalRecord(s.external_ref) : null
                  // Self-invalidating (#1364 review): a stored verification is
                  // only rendered while the row still points at the SAME
                  // record — a re-sync that changes the row's shape drops the
                  // stale verdict instead of showing it under a changed row.
                  // #3018: the identity differs per provider — Fortnox binds
                  // the verdict to the invoice number; Accounted's verdict
                  // carries no number, so it binds to the document id (a
                  // document_ref on the verdict is always this row's own —
                  // the connector refuses a ref it cannot vouch for).
                  const stored = verifications[s.payment_id]
                  const v =
                    stored &&
                    ('error' in stored ||
                      (record?.kind === 'document' && stored.document_ref !== null) ||
                      (record?.kind === 'invoice' && String(stored.invoice_number) === record.id))
                      ? stored
                      : undefined
                  return (
                    <div key={`${s.provider}-${s.payment_id}`}>
                      {/*
                        Not `ui/Row` (#2869 capture): it truncates title and
                        subtitle to one line and never wraps its trailing slot,
                        so at 390px the Check-in-Fortnox button squeezed the id
                        to "pay_01…3…" and the invoice line to "Fortnox inv…".
                        Same reason #2868 chose `SettingsRow`: the actions
                        stack under the text below `sm`.
                      */}
                      <div className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-[var(--v2-ink)]">{truncate(s.payment_id)}</p>
                          <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]">
                            {s.error ??
                              (record?.kind === 'invoice'
                                ? t.accountingPage.rowIdentity.invoice(record.id)
                                : record?.kind === 'document'
                                  ? t.accountingPage.rowIdentity.document(record.id)
                                  : s.attempts > 1
                                    ? `${s.attempts} attempts`
                                    : providerDisplayName(s.provider))}
                          </p>
                        </div>
                        <span className="flex shrink-0 items-center gap-2">
                          {record && (
                            <Button
                              variant="ghost"
                              onClick={() => void runVerify(s.payment_id)}
                              disabled={verifying !== null}
                            >
                              {verifying === s.payment_id ? 'Checking…' : t.accountingPage.verify.checkIn(providerDisplayName(s.provider))}
                            </Button>
                          )}
                          <StatusChip status={s.status} />
                        </span>
                      </div>
                      <div aria-live="polite">
                        {v && (
                          <div className="flex items-center justify-between gap-3 px-5 pb-3">
                            <p
                              className={`text-xs ${
                                'error' in v ? TONE_TEXT.danger : TONE_TEXT[verificationSummary(v, s.provider, t).tone]
                              }`}
                            >
                              {'error' in v
                                ? v.error
                                : `${verificationSummary(v, s.provider, t).text} Checked ${new Date(v.checked_at).toLocaleTimeString()}.`}
                            </p>
                            {!('error' in v) && !v.registered && (
                              <Button
                                variant="ghost"
                                onClick={() => void runReopen(s.payment_id)}
                                disabled={busy !== null}
                              >
                                Re-open for sync
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </Card.Section>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}
