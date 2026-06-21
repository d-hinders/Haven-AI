'use client'

import { useState } from 'react'
import { useReporting, type ReportingSyncStatus } from '@/hooks/useReporting'
import { useFortnox } from '@/hooks/useAccounting'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Row } from '@/components/ui/Row'
import { PageHeader } from '@/components/ui/PageHeader'
import { Skeleton } from '@/components/ui/Skeleton'
import { truncate } from '@/lib/format'

const STATUS: Record<ReportingSyncStatus, { label: string; cls: string }> = {
  pushed: { label: 'Synced', cls: 'bg-[var(--v2-success-soft)] text-[var(--v2-success)]' },
  pending: { label: 'Pending', cls: 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-2)]' },
  failed: { label: 'Failed', cls: 'bg-[var(--v2-danger-soft)] text-[var(--v2-danger)]' },
  skipped: { label: 'Skipped', cls: 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-3)]' },
}

function StatusChip({ status }: { status: ReportingSyncStatus }) {
  const s = STATUS[status]
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${s.cls}`}>{s.label}</span>
}

export default function ReportingPage() {
  const { status, loading, error, sync } = useReporting()
  const { connect, disconnect } = useFortnox()
  const [busy, setBusy] = useState<'sync' | 'connect' | 'disconnect' | null>(null)

  const run = async (kind: 'sync' | 'connect' | 'disconnect', fn: () => Promise<void>) => {
    setBusy(kind)
    try { await fn() } finally { setBusy(null) }
  }

  if (loading) {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Reporting" subtitle="Sync your agent spend into your accounting tool." />
        <Skeleton variant="text" className="h-5 w-64" />
      </div>
    )
  }

  // Self-hosted (or feature not live): the hosted-only add-on is hidden entirely.
  if (!status || !status.hosted || !status.flagEnabled) return null

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Reporting"
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
          <Card className="p-5" hover={false}>
            <Row
              title="Fortnox"
              subtitle={status.connected ? 'Connected' : 'Not connected'}
              leadingTone={status.connected ? 'success' : 'neutral'}
              leading={<span className="text-sm">FN</span>}
              trailing={
                status.connected ? (
                  <Button variant="ghost" onClick={() => run('disconnect', disconnect)} disabled={busy !== null}>
                    Disconnect
                  </Button>
                ) : (
                  <Button onClick={() => run('connect', connect)} disabled={busy !== null}>Connect</Button>
                )
              }
            />
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
                {status.syncs.map((s) => (
                  <Row
                    key={`${s.provider}-${s.payment_id}`}
                    className="px-5"
                    title={truncate(s.payment_id)}
                    subtitle={s.error ?? (s.attempts > 1 ? `${s.attempts} attempts` : s.provider)}
                    trailing={<StatusChip status={s.status} />}
                  />
                ))}
              </Card.Section>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}
