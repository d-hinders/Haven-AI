'use client'

/**
 * The sponsored-gas view (#3837): what Haven's delegation-rail gas
 * sponsorship costs, per merchant per day, next to the value the sponsored
 * funding legs moved. Monitoring only — no threshold, no alert: the owner
 * decision (2026-10-09) is to see what a normal day looks like first.
 */
import { useEffect, useState } from 'react'
import { Card, PageHeader, Table } from '@haven_ai/ui'
import { useOpsClient } from '../../components/useOpsClient'
import { PageStates } from '../../components/PageStates'
import type { OpsReadError } from '../../lib/ops-client'
import type { OpsSponsoredGas } from '../../lib/ops-types'

type OpsSponsoredGasRow = OpsSponsoredGas['rows'][number]

/** ETH figures are derived, not atomic money — a fixed 1e18 here is fine and the backend states the basis. */
function formatEth(wei: string | null): string {
  if (wei == null) return '—'
  const eth = Number(wei) / 1e18
  // Enough precision to read a gas bill: gas on Base is ~1e-4 ETH scale.
  return eth === 0 ? '0' : eth.toFixed(eth < 0.0001 ? 8 : 6)
}

function formatUsd(value: number | null): string {
  if (value == null) return '—'
  return `$${value.toFixed(value < 0.01 ? 6 : 2)}`
}

function legLabel(leg: OpsSponsoredGasRow['leg']): string {
  return leg === 'x402_funding' ? 'x402 funding' : 'Direct'
}

function bucketLabel(row: OpsSponsoredGasRow): string {
  return row.leg === 'x402_funding' ? (row.merchant_host ?? '(no resource URL)') : 'Direct payments'
}

function SponsoredGasView({ client }: { client: ReturnType<typeof useOpsClient> }) {
  const [data, setData] = useState<OpsSponsoredGas | null>(null)
  const [error, setError] = useState<OpsReadError | null>(null)

  useEffect(() => {
    let cancelled = false
    client.sponsoredGas().then((read) => {
      if (cancelled) return
      if (read.ok) setData(read.data)
      else setError(read.error)
    })
    return () => {
      cancelled = true
    }
  }, [client])

  const rows = data?.rows ?? []
  const totalGasEth = rows.reduce((sum, r) => sum + (r.gas_eth ?? 0), 0)
  const totalGasUsd = rows.reduce((sum, r) => sum + (r.gas_usd ?? 0), 0)
  const totalValue = rows.reduce((sum, r) => sum + r.value_moved_usd, 0)
  const totalLegs = rows.reduce((sum, r) => sum + r.funding_legs, 0)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sponsored gas"
        subtitle="What gas sponsorship costs per merchant per day, next to the value the sponsored ops moved."
      />
      <PageStates
        loading={data === null && error === null}
        empty={data !== null && rows.length === 0}
        error={error}
        emptyTitle="No sponsored ops recorded"
        emptyBody={`No sponsored UserOps were submitted in the last ${data?.days ?? 30} days — the ledger is empty for this window.`}
      >
        {data !== null ? (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Sponsored ops" value={totalLegs.toLocaleString('en-US')} />
              <Stat label={`Gas (last ${data.days} d, ETH)`} value={formatEth(String(Math.round(totalGasEth * 1e18)))} />
              <Stat label={`Gas (last ${data.days} d, USD)`} value={formatUsd(data.eth_price_usd == null ? null : totalGasUsd)} />
              <Stat label="Value moved" value={formatUsd(totalValue)} />
            </div>

            <Card className="p-6" hover={false}>
              <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Per merchant per day</h2>
              <div className="mt-3 overflow-x-auto">
                <Table>
                  <Table.Head sticky={false} collapseWhenNarrow={false}>
                    <tr>
                      <Table.HeaderCell>Day (UTC)</Table.HeaderCell>
                      <Table.HeaderCell>Bucket</Table.HeaderCell>
                      <Table.HeaderCell>Leg</Table.HeaderCell>
                      <Table.HeaderCell align="right">Ops</Table.HeaderCell>
                      <Table.HeaderCell align="right">Gas (ETH)</Table.HeaderCell>
                      <Table.HeaderCell align="right">Gas (USD)</Table.HeaderCell>
                      <Table.HeaderCell align="right">Value moved</Table.HeaderCell>
                      <Table.HeaderCell align="right">Gas / value</Table.HeaderCell>
                    </tr>
                  </Table.Head>
                  <Table.Body>
                    {rows.map((row, i) => (
                      <tr key={`${row.day}-${row.leg}-${row.merchant_host ?? ''}-${i}`}>
                        <td className="v2-tabular py-1.5 text-[var(--v2-ink-2)]">{row.day}</td>
                        <td className="py-1.5 text-[var(--v2-ink)]">{bucketLabel(row)}</td>
                        <td className="py-1.5 text-[var(--v2-ink-2)]">{legLabel(row.leg)}</td>
                        <td className="v2-tabular py-1.5 text-right text-[var(--v2-ink-2)]">{row.funding_legs.toLocaleString('en-US')}</td>
                        <td className="v2-tabular py-1.5 text-right text-[var(--v2-ink-2)]">{formatEth(row.gas_cost_wei)}</td>
                        <td className="v2-tabular py-1.5 text-right text-[var(--v2-ink-2)]">{formatUsd(row.gas_usd)}</td>
                        <td className="v2-tabular py-1.5 text-right text-[var(--v2-ink-2)]">{formatUsd(row.value_moved_usd)}</td>
                        <td className="v2-tabular py-1.5 text-right text-[var(--v2-ink-2)]">
                          {row.gas_value_ratio == null ? '—' : `${(row.gas_value_ratio * 100).toFixed(4)}%`}
                        </td>
                      </tr>
                    ))}
                  </Table.Body>
                </Table>
              </div>
            </Card>

            <Card className="p-6" hover={false}>
              <h2 className="text-sm font-semibold text-[var(--v2-ink)]">How to read this</h2>
              <div className="mt-3 space-y-2 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                <p>
                  Gas is each sponsored UserOp&apos;s EntryPoint <span className="v2-tabular">actualGasCost</span>. That
                  figure already includes <span className="v2-tabular">preVerificationGas</span> — through which bundlers
                  recover Base&apos;s L1 data fee — so the transaction-level <span className="v2-tabular">l1Fee</span> is
                  not added on top (it would double-count).
                </p>
                <p>
                  ETH is priced at VIEW time
                  {data.eth_price_usd == null
                    ? ' — the price feed returned nothing usable right now, so USD gas figures show — until a quote is available.'
                    : ` at $${data.eth_price_usd} per ETH. The USD figures move with the market; the wei figures do not.`}
                </p>
                <p>
                  Value moved is the joined payment intents&apos; booked USD value — only CONFIRMED intents count, so a
                  reverted op shows its burned gas but zero value. Ops with an unknown outcome (receipt never confirmed)
                  count once with no known cost.
                </p>
                <p>Direct payments have no merchant and appear as their own bucket; x402 funding legs bucket by the merchant host of the payment&apos;s resource URL. Monitoring only — no thresholds or alerts are defined on this view.</p>
              </div>
            </Card>

            <p className="text-xs text-[var(--v2-ink-3)]">
              Generated {new Date(data.generated_at).toISOString().slice(0, 16).replace('T', ' ')} UTC.
            </p>
          </div>
        ) : null}
      </PageStates>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--v2-line)] p-4">
      <div className="text-xs text-[var(--v2-ink-3)]">{label}</div>
      <div className="v2-tabular mt-1 text-lg font-semibold text-[var(--v2-ink)]">{value}</div>
    </div>
  )
}

export default function SponsoredGasPage() {
  const client = useOpsClient()
  return <SponsoredGasView client={client} />
}
