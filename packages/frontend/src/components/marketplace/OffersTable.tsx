'use client'

import { Table } from '@/components/ui/Table'
import { withinBudget } from '@/lib/marketplace'
import { OfferRow } from './OfferRow'
import type { CatalogEntry } from '@/hooks/useCatalog'

/**
 * The merchant page's offers table (#3079, epic #3077). Dense and
 * non-collapsing (`Table`'s documented shape for admin tables that need to
 * scroll rather than shed columns): the caller wraps it in its own
 * `overflow-x-auto` container so it scrolls horizontally on mobile without
 * taking the page with it.
 */
export function OffersTable({
  offers,
  agents,
}: {
  offers: CatalogEntry[]
  agents: Array<{ status: string; allowances: Array<{ token_symbol: string; allowance_amount: string }> }>
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--v2-border)]">
      <Table className="min-w-[720px]">
        <Table.Head collapseWhenNarrow={false}>
          <tr>
            <Table.HeaderCell align="left">Tool / method</Table.HeaderCell>
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
  )
}
