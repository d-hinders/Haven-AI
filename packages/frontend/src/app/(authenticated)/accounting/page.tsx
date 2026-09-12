'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  useAccountingFeed,
  type AccountingSyncStatus,
  type AccountingVerification,
} from '@/hooks/useAccountingFeed'
import { useT } from '@/context/LocaleContext'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Row } from '@/components/ui/Row'
import { PageHeader } from '@/components/ui/PageHeader'
import { Skeleton } from '@/components/ui/Skeleton'
import { CONNECT_OUTCOME_PARAMS, readConnectOutcome } from '@/components/accounting/ConnectionsCard'
import { truncate } from '@/lib/format'

/** Where the connection is managed (#2868): Settings owns Connect / Reconnect / Disconnect. */
const ACCOUNTING_SETTINGS_HREF = '/settings'

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

/** Same tone convention as Row's leadingTone — text-color variant (#1364 review). */
const TONE_TEXT: Record<'success' | 'warning' | 'danger', string> = {
  success: 'text-[var(--v2-success)]',
  warning: 'text-[var(--v2-warning)]',
  danger: 'text-[var(--v2-danger)]',
}

function StatusChip({ status }: { status: AccountingSyncStatus }) {
  const s = STATUS[status]
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>
}

/** "fortnox:supplierinvoice:123" → 123 (the number shown in Fortnox's UI). */
function fortnoxInvoiceNumber(externalRef: string | null): string | null {
  const match = externalRef?.match(/^fortnox:supplierinvoice:(\d+)$/)
  return match ? match[1] : null
}

/** Plain-language verdict from a read-back verification (#1362). */
function verificationSummary(v: AccountingVerification): { text: string; tone: 'success' | 'warning' | 'danger' } {
  if (!v.registered) {
    return {
      text: `Not found in Fortnox — invoice ${v.invoice_number} no longer exists there.`,
      tone: 'danger',
    }
  }
  if (v.cancelled) {
    return { text: `Registered in Fortnox as invoice ${v.invoice_number}, but cancelled there.`, tone: 'warning' }
  }
  if (v.booked) {
    return {
      text: `Booked in Fortnox — invoice ${v.invoice_number}${v.voucher ? `, voucher ${v.voucher}` : ''}. Your accountant has accounted for it.`,
      tone: 'success',
    }
  }
  return {
    text: `Registered in Fortnox as invoice ${v.invoice_number} — awaiting booking by your accountant.`,
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
          : 'Could not check Fortnox right now. Try again in a moment.'
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

  if (loading) {
    return (
      <div className="max-w-3xl">
        {forwarder}
        <PageHeader title="Accounting" subtitle="Sync your agent spend into your accounting tool." />
        <Skeleton variant="text" className="h-5 w-64" />
      </div>
    )
  }

  // Self-hosted (or feature not live): the hosted-only add-on is hidden entirely.
  if (!status || !status.hosted || !status.flagEnabled) return forwarder

  return (
    <div className="max-w-3xl">
      {forwarder}
      <PageHeader
        title="Accounting"
        subtitle="Your agent spend appears in your accounting tool as draft transactions — your accountant codes and confirms them."
      />

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
              <p className="text-sm font-medium text-[var(--v2-warning)]">Preview — not yet delivering to Fortnox</p>
              <p className="mt-1 text-sm text-[var(--v2-ink-2)]">
                The accounting feed is built and your settled payments are tracked here, but the live Fortnox
                connection isn&apos;t wired up yet — transactions are not being sent to your accounting tool. We&apos;ll
                enable delivery in a follow-up; nothing you do here posts to Fortnox in the meantime.
              </p>
            </div>
          )}

          {/*
            The Connect / Disconnect controls moved to Settings → Accounting
            (#2868). This row only says where they went; the feed below keeps
            working off the active destination.
          */}
          <Card className="p-0" hover={false}>
            <Row
              className="px-5"
              title="Fortnox"
              subtitle={status.connected ? t.settings.accounting.status.connected : t.settings.accounting.status.disconnected}
              leadingTone={status.connected ? 'success' : 'neutral'}
              leading={<span className="text-sm">FN</span>}
              trailing={
                <Button variant="ghost" href={ACCOUNTING_SETTINGS_HREF}>
                  {t.accountingPage.openSettings}
                </Button>
              }
            />
            <p className="px-5 pb-4 text-xs text-[var(--v2-ink-3)]">{t.accountingPage.manageInSettings}</p>
          </Card>

          <Card className="p-0" hover={false}>
            <div className="flex items-center justify-between p-5">
              <div>
                <h2 className="v2-text-h3 text-[var(--v2-ink)]">Synced transactions</h2>
                <p className="mt-1 text-sm text-[var(--v2-ink-2)]">Drafts fed to your accounting tool. Failures retry on sync.</p>
              </div>
              <Button
                variant="ghost"
                onClick={() => run('sync', sync)}
                disabled={busy !== null || !status.connected}
              >
                {busy === 'sync' ? 'Syncing…' : 'Sync now'}
              </Button>
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
                  const invoiceNo = s.status === 'pushed' ? fortnoxInvoiceNumber(s.external_ref) : null
                  // Self-invalidating (#1364 review): a stored verification is
                  // only rendered while the row still points at the SAME
                  // invoice — a re-sync that changes the row's shape drops the
                  // stale verdict instead of showing it under a changed row.
                  const stored = verifications[s.payment_id]
                  const v =
                    stored && ('error' in stored || String(stored.invoice_number) === invoiceNo)
                      ? stored
                      : undefined
                  return (
                    <div key={`${s.provider}-${s.payment_id}`}>
                      <Row
                        className="px-5"
                        title={truncate(s.payment_id)}
                        subtitle={
                          s.error ??
                          (invoiceNo
                            ? `Fortnox invoice ${invoiceNo}`
                            : s.attempts > 1
                              ? `${s.attempts} attempts`
                              : s.provider)
                        }
                        trailing={
                          <span className="flex items-center gap-2">
                            {invoiceNo && (
                              <Button
                                variant="ghost"
                                onClick={() => void runVerify(s.payment_id)}
                                disabled={verifying !== null}
                              >
                                {verifying === s.payment_id ? 'Checking…' : 'Check in Fortnox'}
                              </Button>
                            )}
                            <StatusChip status={s.status} />
                          </span>
                        }
                      />
                      <div aria-live="polite">
                        {v && (
                          <div className="flex items-center justify-between gap-3 px-5 pb-3">
                            <p
                              className={`text-xs ${
                                'error' in v ? TONE_TEXT.danger : TONE_TEXT[verificationSummary(v).tone]
                              }`}
                            >
                              {'error' in v
                                ? v.error
                                : `${verificationSummary(v).text} Checked ${new Date(v.checked_at).toLocaleTimeString()}.`}
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
