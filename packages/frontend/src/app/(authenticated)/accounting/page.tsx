'use client'

import { useState, type ReactNode } from 'react'
import { api, ApiRequestError } from '@/lib/api'
import {
  useReconcile,
  useMerchantAccounts,
  useFortnox,
  type ReconcileStatus,
} from '@/hooks/useAccounting'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { PageHeader } from '@/components/ui/PageHeader'
import { Skeleton } from '@/components/ui/Skeleton'

function SectionCard({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <Card className="p-5" hover={false}>
      <div className="mb-4">
        <h2 className="v2-text-h3 text-[var(--v2-ink)]">{title}</h2>
        {description && <p className="mt-1 text-sm text-[var(--v2-ink-2)]">{description}</p>}
      </div>
      {children}
    </Card>
  )
}

const STATUS_LABEL: Record<ReconcileStatus, string> = {
  ok: 'OK',
  missing_fx: 'No SEK value',
  missing_tx: 'No tx hash',
  unbalanced: 'Unbalanced',
}

// ── SIE export ──────────────────────────────────────────────────────
function ExportCard() {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [company, setCompany] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const download = async () => {
    setBusy(true)
    setError('')
    try {
      const params = new URLSearchParams({ format: 'sie' })
      if (from) params.set('from', from)
      if (to) params.set('to', to)
      if (company.trim()) params.set('company', company.trim())
      const content = await api.getText(`/accounting/export?${params.toString()}`)
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `haven-books-${new Date().toISOString().slice(0, 10)}.si`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Export failed. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SectionCard
      title="SIE export"
      description="Download a SIE 4I file of settled agent payments — import it into Fortnox, Visma, Bokio or any Swedish accounting tool. Amounts are SEK as of settlement."
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="sie-from" className="mb-1.5 block text-xs font-medium text-[var(--v2-ink-2)]">From</label>
          <Input id="sie-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label htmlFor="sie-to" className="mb-1.5 block text-xs font-medium text-[var(--v2-ink-2)]">To</label>
          <Input id="sie-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div>
          <label htmlFor="sie-company" className="mb-1.5 block text-xs font-medium text-[var(--v2-ink-2)]">Company name</label>
          <Input id="sie-company" type="text" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Acme AB" />
        </div>
      </div>
      {error && (
        <div className="mt-3 rounded-lg border border-[var(--v2-danger)]/20 bg-[var(--v2-danger-soft)] px-3 py-2.5 text-sm text-[var(--v2-danger)]">{error}</div>
      )}
      <div className="mt-4">
        <Button onClick={download} disabled={busy}>{busy ? 'Preparing…' : 'Download SIE'}</Button>
      </div>
    </SectionCard>
  )
}

// ── Reconciliation ──────────────────────────────────────────────────
function ReconcileCard() {
  const { report, loading, error, refetch } = useReconcile()

  return (
    <SectionCard
      title="Reconciliation"
      description="Entries that can't be booked cleanly yet — fix these before filing."
    >
      {loading ? (
        <Skeleton variant="text" className="h-4 w-48" />
      ) : error ? (
        <p className="text-sm text-[var(--v2-danger)]">{error}</p>
      ) : report ? (
        <>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <span className="text-[var(--v2-ink-2)]">{report.total} settled</span>
            <span className="text-[var(--v2-success)]">{report.ok} OK</span>
            <span className={report.issues > 0 ? 'text-[var(--v2-danger)]' : 'text-[var(--v2-ink-3)]'}>
              {report.issues} need attention
            </span>
            <button onClick={refetch} className="ml-auto text-xs text-[var(--v2-brand)] hover:underline">Refresh</button>
          </div>
          {report.items.length > 0 && (
            <div className="mt-4 overflow-hidden rounded-lg border border-[var(--v2-border)]">
              <table className="w-full text-sm">
                <thead className="bg-[var(--v2-table-header-bg)] text-left text-xs text-[var(--v2-ink-3)]">
                  <tr>
                    <th className="px-3 py-2 font-medium">Date</th>
                    <th className="px-3 py-2 font-medium">Tx</th>
                    <th className="px-3 py-2 font-medium">Issue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--v2-border)]">
                  {report.items.map((item) => (
                    <tr key={item.paymentId}>
                      <td className="px-3 py-2 text-[var(--v2-ink-2)]">{item.settledAt.slice(0, 10)}</td>
                      <td className="px-3 py-2 font-mono text-xs text-[var(--v2-ink-3)]">
                        {item.txHash ? `${item.txHash.slice(0, 10)}…` : '—'}
                      </td>
                      <td className="px-3 py-2 text-[var(--v2-danger)]">{STATUS_LABEL[item.status]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </SectionCard>
  )
}

// ── Fortnox ─────────────────────────────────────────────────────────
function FortnoxCard() {
  const { status, loading, connect, disconnect, push } = useFortnox()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const handlePush = async () => {
    setBusy(true)
    setMessage('')
    try {
      const res = await push()
      setMessage(`Pushed ${res.pushed}, skipped ${res.skipped}, failed ${res.failed}.`)
    } catch (err) {
      setMessage(err instanceof ApiRequestError ? err.message : 'Push failed. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SectionCard
      title="Fortnox"
      description="Push vouchers straight into Fortnox — no file handling. SIE export stays available as a fallback."
    >
      {loading ? (
        <Skeleton variant="text" className="h-4 w-40" />
      ) : !status?.configured ? (
        <p className="text-sm text-[var(--v2-ink-3)]">
          Fortnox isn’t configured on this environment. Use the SIE export above, or ask an admin to set the Fortnox credentials.
        </p>
      ) : status.connected ? (
        <>
          <div className="flex items-center gap-2 text-sm">
            <span className="inline-block h-2 w-2 rounded-full bg-[var(--v2-success)]" />
            <span className="text-[var(--v2-ink-2)]">Connected</span>
          </div>
          {message && <p className="mt-3 text-sm text-[var(--v2-ink-2)]">{message}</p>}
          <div className="mt-4 flex gap-3">
            <Button onClick={handlePush} disabled={busy}>{busy ? 'Pushing…' : 'Push vouchers'}</Button>
            <Button variant="ghost" onClick={disconnect} disabled={busy}>Disconnect</Button>
          </div>
        </>
      ) : (
        <Button onClick={connect}>Connect Fortnox</Button>
      )}
    </SectionCard>
  )
}

// ── Merchant account overrides ──────────────────────────────────────
function CategoriesCard() {
  const { overrides, loading, setAccount, removeAccount } = useMerchantAccounts()
  const [resourceUrl, setResourceUrl] = useState('')
  const [account, setAccountInput] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const add = async () => {
    if (!resourceUrl.trim() || !/^\d{3,6}$/.test(account.trim())) {
      setError('Enter a merchant URL and a BAS account number.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await setAccount(resourceUrl.trim(), account.trim())
      setResourceUrl('')
      setAccountInput('')
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SectionCard
      title="Merchant accounts"
      description="Map a merchant to a BAS account once; every future entry for it reuses your choice."
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_140px_auto] sm:items-end">
        <div>
          <label htmlFor="cat-url" className="mb-1.5 block text-xs font-medium text-[var(--v2-ink-2)]">Merchant URL</label>
          <Input id="cat-url" type="text" value={resourceUrl} onChange={(e) => setResourceUrl(e.target.value)} placeholder="https://mcp.example/mcp" className="font-mono" />
        </div>
        <div>
          <label htmlFor="cat-acct" className="mb-1.5 block text-xs font-medium text-[var(--v2-ink-2)]">BAS account</label>
          <Input id="cat-acct" type="text" value={account} onChange={(e) => setAccountInput(e.target.value)} placeholder="6540" />
        </div>
        <Button onClick={add} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
      </div>
      {error && <p className="mt-2 text-sm text-[var(--v2-danger)]">{error}</p>}

      <div className="mt-4">
        {loading ? (
          <Skeleton variant="text" className="h-4 w-48" />
        ) : overrides.length === 0 ? (
          <p className="text-sm text-[var(--v2-ink-3)]">No overrides yet — entries use the default account map.</p>
        ) : (
          <div className="divide-y divide-[var(--v2-border)] rounded-lg border border-[var(--v2-border)]">
            {overrides.map((o) => (
              <div key={o.resource_url} className="flex items-center gap-3 px-3 py-2.5">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--v2-ink-2)]">{o.resource_url}</span>
                <span className="font-mono text-sm text-[var(--v2-ink)]">{o.bas_account}</span>
                <button onClick={() => removeAccount(o.resource_url)} className="text-xs text-[var(--v2-danger)] hover:underline">Remove</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </SectionCard>
  )
}

export default function AccountingPage() {
  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Accounting"
        subtitle="Export bookkeeping-ready records of your agents’ spend, reconcile them, and push to Fortnox."
      />

      <Card elevation="anchor" className="mb-5 p-4" hover={false}>
        <p className="text-sm font-medium text-[var(--v2-ink)]">Proposed records — review before filing</p>
        <ul className="mt-2 space-y-1.5 text-sm text-[var(--v2-ink-2)]">
          <li>
            Haven proposes these entries from your settled payments — it is not your accountant. Confirm them before filing.
          </li>
          <li>
            VAT is a flagged default: foreign suppliers are booked as reverse charge. EU vs non-EU and domestic Swedish VAT
            need your confirmation — supplier country isn’t always known yet, so some entries fall back to the default account.
          </li>
          <li>
            Verify the first export in your accounting tool (SIE import or Fortnox) before relying on it.
          </li>
        </ul>
      </Card>

      <div className="space-y-5">
        <ExportCard />
        <ReconcileCard />
        <FortnoxCard />
        <CategoriesCard />
      </div>
    </div>
  )
}
