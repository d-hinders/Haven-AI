'use client'

/**
 * The ops overview (#3516): `/ops/overview` counts as stat tiles, smart
 * accounts split by `account_type`. Counts only — the page never lists, and
 * a customer is one search away.
 */
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Card, PageHeader, StatTile } from '@haven_ai/ui'
import { useOpsClient } from '../../components/useOpsClient'
import type { OpsReadError } from '../../lib/ops-client'
import type { OpsOverview } from '../../lib/ops-types'
import { PageStates } from '../../components/PageStates'

function CountRow({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-[var(--v2-ink-2)]">{label}</span>
      <span className="v2-tabular text-sm font-medium text-[var(--v2-ink)]">
        {count.toLocaleString('en-US')}
      </span>
    </div>
  )
}

function OverviewView({ client }: { client: ReturnType<typeof useOpsClient> }) {
  const [overview, setOverview] = useState<OpsOverview | null>(null)
  const [error, setError] = useState<OpsReadError | null>(null)

  useEffect(() => {
    let cancelled = false
    client.overview().then((read) => {
      if (cancelled) return
      if (read.ok) setOverview(read.data)
      else setError(read.error)
    })
    return () => {
      cancelled = true
    }
  }, [client])

  const agents = overview?.agents_by_status ?? []
  const agentTotal = agents.reduce((sum, row) => sum + row.count, 0)
  const intents = overview?.payment_intents_24h ?? []
  const intentTotal = intents.reduce((sum, row) => sum + row.count, 0)
  const refusals = overview?.payment_refusals_24h ?? []
  const refusalTotal = refusals.reduce((sum, row) => sum + row.count, 0)

  return (
    <div className="space-y-6">
      <PageHeader title="Overview" subtitle="Platform counts, read through the audited ops surface." />
      <PageStates
        loading={overview === null && error === null}
        empty={overview !== null && overview.users === 0}
        error={error}
        emptyTitle="No users yet"
        emptyBody="The platform has no users, so every other count is zero too."
      >
        {overview !== null ? (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile label="Users" value={overview.users.toLocaleString('en-US')} />
              <StatTile label="Agents" value={agentTotal.toLocaleString('en-US')} />
              <StatTile label="Active delegations" value={overview.active_delegations.toLocaleString('en-US')} />
              <StatTile label="Payments (24 h)" value={intentTotal.toLocaleString('en-US')} />
            </div>
            <div className="grid gap-6 lg:grid-cols-2">
              <Card className="p-6" hover={false}>
                <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Smart accounts by chain and type</h2>
                <div className="mt-3 space-y-2">
                  {overview.smart_accounts.length === 0 ? (
                    <p className="text-sm text-[var(--v2-ink-2)]">No smart accounts yet.</p>
                  ) : (
                    overview.smart_accounts.map((row) => (
                      <CountRow
                        key={`${row.chain_id}-${row.account_type}`}
                        label={`Chain ${row.chain_id} · ${row.account_type}`}
                        count={row.count}
                      />
                    ))
                  )}
                </div>
              </Card>
              <div className="space-y-6">
                <Card className="p-6" hover={false}>
                  <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Agents by status</h2>
                  <div className="mt-3 space-y-2">
                    {agents.length === 0 ? (
                      <p className="text-sm text-[var(--v2-ink-2)]">No agents yet.</p>
                    ) : (
                      agents.map((row) => <CountRow key={row.status} label={row.status} count={row.count} />)
                    )}
                  </div>
                </Card>
                <Card className="p-6" hover={false}>
                  <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Last 24 hours</h2>
                  <div className="mt-3 space-y-2 text-sm">
                    <CountRow label="Payment refusals" count={refusalTotal} />
                    {refusals.map((row) => (
                      <div key={row.reason} className="flex items-center justify-between text-xs">
                        <span className="v2-tabular text-[var(--v2-ink-3)]">{row.reason}</span>
                        <span className="v2-tabular text-[var(--v2-ink-2)]">
                          {row.count.toLocaleString('en-US')}
                        </span>
                      </div>
                    ))}
                    <p className="text-xs text-[var(--v2-ink-3)]">
                      Counts read {new Date(overview.generated_at).toISOString().slice(0, 16).replace('T', ' ')} UTC.
                    </p>
                  </div>
                </Card>
              </div>
            </div>
            <p className="text-xs text-[var(--v2-ink-3)]">
              Looking for a customer?{' '}
              <Link className="underline" href="/search">
                Search
              </Link>
              .
            </p>
          </div>
        ) : null}
      </PageStates>
    </div>
  )
}

export default function OverviewPage() {
  const client = useOpsClient()
  return <OverviewView client={client} />
}
