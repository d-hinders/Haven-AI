'use client'

/**
 * The ops health page (#3516): `GET /ops/health` (#3514) as one operational
 * glance — sweepable intents (in_window and past_horizon), stuck passport
 * revocations, stuck outbound lanes with a copyable `outbound_txs.id`,
 * delegate balances (the monitor's last report, or
 * `not_available_on_this_replica`), and the `/health/ops` diagnostics.
 *
 * Items link to the customer page where a link exists — lanes deliberately
 * have none (`outbound_txs` carries no user column, #3514). The page makes
 * NO RPC call and performs no write; it reads one endpoint.
 */
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Card, CopyButton, EmptyState, PageHeader, StatusBadge } from '@haven_ai/ui'
import { useOpsClient } from '../../components/useOpsClient'
import { PageStates } from '../../components/PageStates'
import type { OpsReadError } from '../../lib/ops-client'
import type { OpsHealth } from '../../lib/ops-types'
import { ageLine, chainName, formatAtomic, utcLine } from '../../lib/format'

function SectionCard({
  title,
  description,
  count,
  children,
}: {
  title: string
  description?: string
  count: number
  children: React.ReactNode
}) {
  return (
    <Card className="overflow-hidden" hover={false}>
      <Card.Header
        as="h2"
        padding="none"
        title={title}
        description={description}
        actions={
          <StatusBadge tone={count > 0 ? 'warning' : 'success'}>
            {count} item{count === 1 ? '' : 's'}
          </StatusBadge>
        }
      />
      {count === 0 ? (
        <div className="p-5">
          <EmptyState title="Nothing stuck" size="compact" />
        </div>
      ) : (
        <Card.Section divided>{children}</Card.Section>
      )}
    </Card>
  )
}

function AgentLink({ agentId }: { agentId: string }) {
  return (
    <Link
      href={`/customer/${agentId}`}
      className="v2-tabular text-xs text-[var(--v2-brand)] underline"
    >
      agent {agentId.slice(0, 8)}…
    </Link>
  )
}

function HealthView({ client }: { client: ReturnType<typeof useOpsClient> }) {
  const [health, setHealth] = useState<OpsHealth | null>(null)
  const [error, setError] = useState<OpsReadError | null>(null)

  useEffect(() => {
    let cancelled = false
    client.health().then((read) => {
      if (cancelled) return
      if (read.ok) setHealth(read.data)
      else setError(read.error)
    })
    return () => {
      cancelled = true
    }
  }, [client])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Health"
        subtitle="What is operationally wrong right now, from one read. Nothing here is acted on from this page."
      />
      <PageStates
        loading={health === null && error === null}
        empty={false}
        error={error}
        emptyTitle="Nothing to show"
      >
        {health !== null ? (
          <div className="space-y-6">
            <p className="text-xs text-[var(--v2-ink-3)]">
              Read at {utcLine(health.generated_at)}. The delegate-balance section is the monitor's last
              report — requesting a health read never triggers a scan.
            </p>

            <SectionCard
              title="Sweepable payment intents"
              description="In the sweeper's window, and past its recovery horizon (the sweeper no longer retries those)."
              count={health.sweepable_intents.length}
            >
              {health.sweepable_intents.map((intent) => (
                <div
                  key={`${intent.id}-${intent.window}`}
                  className="flex flex-wrap items-center justify-between gap-2 px-5 py-3"
                >
                  <div>
                    <p className="v2-tabular text-sm font-medium text-[var(--v2-ink)]">
                      {intent.amount_human} {intent.token_symbol}
                    </p>
                    <p className="text-xs text-[var(--v2-ink-3)]">
                      <AgentLink agentId={intent.agent_id} /> · chain {intent.chain_id} · status {intent.status}{' '}
                      · age {ageLine(intent.age_seconds)}
                    </p>
                  </div>
                  <StatusBadge tone={intent.window === 'past_horizon' ? 'danger' : 'warning'}>
                    {intent.window}
                  </StatusBadge>
                </div>
              ))}
            </SectionCard>

            <SectionCard
              title="Stuck passport revocations"
              description="Revocation requested but the chain still shows the agent as valid."
              count={health.stuck_revocations.length}
            >
              {health.stuck_revocations.map((revocation, index) => (
                <div
                  key={`${revocation.agent_id}-${index}`}
                  className="flex flex-wrap items-center justify-between gap-2 px-5 py-3"
                >
                  <p className="text-xs text-[var(--v2-ink-3)]">
                    <AgentLink agentId={revocation.agent_id} /> · {revocation.revocation_attempts} attempt
                    {revocation.revocation_attempts === 1 ? '' : 's'} · age {ageLine(revocation.age_seconds)}
                  </p>
                  <span className="v2-tabular text-xs text-[var(--v2-ink-3)]">
                    requested {utcLine(revocation.revocation_requested_at)}
                  </span>
                </div>
              ))}
            </SectionCard>

            <SectionCard
              title="Stuck outbound lanes"
              description="Unmined past the stale threshold, or at the bump cap. The lane id is the handle the operator pastes into the cancel tool; a listed lane may already be mined."
              count={health.stuck_lanes.length}
            >
              {health.stuck_lanes.map((lane, index) => (
                <div
                  key={`${lane.id}-${index}`}
                  className="flex flex-wrap items-center justify-between gap-2 px-5 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="v2-tabular text-sm text-[var(--v2-ink)]">{lane.id}</span>
                      <CopyButton value={lane.id} label="lane id" />
                    </div>
                    <p className="v2-tabular mt-0.5 text-xs text-[var(--v2-ink-3)]">
                      {chainName(lane.chain_id)} · submitter {lane.submitter} · nonce {lane.nonce} · age{' '}
                      {ageLine(lane.age_seconds)}
                    </p>
                  </div>
                  <StatusBadge tone={lane.reason === 'capped_needs_operator' ? 'danger' : 'warning'}>
                    {lane.reason}
                  </StatusBadge>
                </div>
              ))}
            </SectionCard>

            <Card className="overflow-hidden" hover={false}>
              <Card.Header
                as="h2"
                padding="none"
                title="Delegate balances"
                description="The monitor's last report. On a replica without the monitor's leader lock there is no report — that is a condition of this process, not an error."
              />
              {health.delegate_balances.available ? (
                <Card.Section>
                  <div className="space-y-2 text-sm">
                    <p className="text-xs text-[var(--v2-ink-3)]">
                      Scanned {utcLine(health.delegate_balances.scanned_at)} ·{' '}
                      {health.delegate_balances.report.scanned_delegates.toLocaleString('en-US')} delegates ·{' '}
                      {health.delegate_balances.report.unread} unread
                    </p>
                    {health.delegate_balances.report.lingering.length === 0 ? (
                      <p className="text-sm text-[var(--v2-ink-2)]">No lingering balances.</p>
                    ) : (
                      health.delegate_balances.report.lingering.map((row, index) => (
                        <div
                          key={`${row.agent_id}-${index}`}
                          className="flex flex-wrap items-center justify-between gap-2"
                        >
                          <span className="text-[var(--v2-ink-2)]">
                            {row.agent_name} · <AgentLink agentId={row.agent_id} /> ·{' '}
                            <span className="v2-tabular">{row.delegate_address}</span>
                          </span>
                          <span className="v2-tabular text-[var(--v2-ink)]">
                            {formatAtomic(row.balance_atomic, 6)} USDC · chain {row.chain_id}
                          </span>
                        </div>
                      ))
                    )}
                    <p className="v2-tabular text-xs text-[var(--v2-ink-3)]">
                      Dust total {formatAtomic(health.delegate_balances.report.dust_total_atomic, 6)}
                      {health.delegate_balances.report.dust_alert ? ' (alerting)' : ''} · chain errors:{' '}
                      {Object.keys(health.delegate_balances.report.chain_errors).length}
                    </p>
                  </div>
                </Card.Section>
              ) : (
                <Card.Section>
                  <StatusBadge tone="neutral">not_available_on_this_replica</StatusBadge>
                  <p className="mt-2 text-xs text-[var(--v2-ink-2)]">
                    This backend does not hold the delegate-balance monitor's leader lock, so it holds no
                    last report. No scan is performed on request.
                  </p>
                </Card.Section>
              )}
            </Card>

            <Card className="overflow-hidden" hover={false}>
              <Card.Header
                as="h2"
                padding="none"
                title="Ops diagnostics"
                description="The GET /health/ops payload: relayer balances, passport state, accounting counters, request validation."
              />
              <Card.Section>
                <pre className="v2-tabular overflow-x-auto text-xs text-[var(--v2-ink-2)]">
                  {JSON.stringify(health.ops_diagnostics, null, 2)}
                </pre>
              </Card.Section>
            </Card>
          </div>
        ) : null}
      </PageStates>
    </div>
  )
}

export default function HealthPage() {
  const client = useOpsClient()
  return <HealthView client={client} />
}
