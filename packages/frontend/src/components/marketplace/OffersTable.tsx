'use client'

import { StatusBadge } from '@/components/ui/StatusBadge'
import { Table } from '@/components/ui/Table'
import { chainName, freshness, networkToChainId, VERIFIED_MEANING, withinBudget } from '@/lib/marketplace'
import { OfferRow } from './OfferRow'
import type { CatalogEntry } from '@/hooks/useCatalog'

type Agents = Array<{ status: string; allowances: Array<{ token_symbol: string; allowance_amount: string }> }>

function BudgetHint({ budget }: { budget: boolean | null }) {
  if (budget === null) return null
  return (
    <p className={`mt-0.5 text-xs font-medium ${budget ? 'text-[var(--v2-success)]' : 'text-[var(--v2-warning)]'}`}>
      {budget ? 'Within your agent budget' : 'Above every agent budget — a payment would be declined'}
    </p>
  )
}

/**
 * One offer as a stacked card — the phone-width shape of the table row
 * below (same cells, same copy, same budget hint), so the warning that
 * prevents a declined payment is never behind a horizontal scroll.
 */
function OfferCard({ entry, budget }: { entry: CatalogEntry; budget: boolean | null }) {
  const degraded = entry.status === 'degraded'
  const method = entry.protocol === 'mcp' ? entry.tool_name : entry.rail
  const chainId = networkToChainId(entry.network)
  return (
    <li
      data-testid={`offer-card-${entry.id}`}
      className="rounded-lg border border-[var(--v2-border)] bg-[var(--v2-bg)] p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-[var(--v2-ink)]">{entry.name}</span>
        {degraded && (
          <span className="rounded-full bg-[var(--v2-warning-soft)] px-2 py-0.5 text-xs font-medium text-[var(--v2-warning)]">
            Limited availability
          </span>
        )}
        {entry.verified_payable && (
          <span title={VERIFIED_MEANING}>
            <StatusBadge tone="success" className="uppercase tracking-wide">
              Verified
            </StatusBadge>
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-[var(--v2-ink-3)]">{entry.description}</p>
      {degraded && (
        <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
          Recently unreachable on our checks — a payment may need a retry until it recovers.
        </p>
      )}
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-[var(--v2-ink-3)]">Price</dt>
        <dd className="v2-tabular font-semibold text-[var(--v2-ink)]">
          {entry.price_display ?? 'Price on request'}
          <BudgetHint budget={budget} />
        </dd>
        <dt className="text-[var(--v2-ink-3)]">Method</dt>
        <dd className="text-[var(--v2-ink-2)]">{method}</dd>
        <dt className="text-[var(--v2-ink-3)]">Network</dt>
        <dd className="text-[var(--v2-ink-2)]">{chainId === undefined ? '—' : chainName(chainId)}</dd>
        <dt className="text-[var(--v2-ink-3)]">Freshness</dt>
        <dd className="text-[var(--v2-ink-3)]">{freshness(entry.verified_at)}</dd>
      </dl>
      <p className="mt-1 break-all text-xs text-[var(--v2-ink-3)]">{entry.resource_url}</p>
    </li>
  )
}

/**
 * The merchant page's offers (#3079, epic #3077). From `md` up: the dense,
 * non-collapsing table. Below `md`: one stacked card per offer — a 720px
 * table behind `overflow-x-auto` at 390 showed one column, a header cut
 * mid-word and no scroll affordance, and hid the budget warning off-screen.
 * Both render the same offers and the same `withinBudget` answer.
 */
export function OffersTable({ offers, agents }: { offers: CatalogEntry[]; agents: Agents }) {
  return (
    <>
      <ul className="space-y-2 md:hidden" data-testid="offers-list">
        {offers.map((offer) => (
          <OfferCard key={offer.id} entry={offer} budget={withinBudget(offer, agents)} />
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-xl border border-[var(--v2-border)] md:block" data-testid="offers-table">
        <Table className="min-w-[720px]">
          <Table.Head collapseWhenNarrow={false}>
            <tr>
              <Table.HeaderCell align="left">Offer</Table.HeaderCell>
              <Table.HeaderCell align="left">Method</Table.HeaderCell>
              <Table.HeaderCell align="left">Description</Table.HeaderCell>
              <Table.HeaderCell align="left">Price</Table.HeaderCell>
              <Table.HeaderCell align="left">Network</Table.HeaderCell>
              <Table.HeaderCell align="left">Freshness</Table.HeaderCell>
            </tr>
          </Table.Head>
          <Table.Body>
            {offers.map((offer) => (
              <OfferRow key={offer.id} entry={offer} budget={withinBudget(offer, agents)} />
            ))}
          </Table.Body>
        </Table>
      </div>
    </>
  )
}
