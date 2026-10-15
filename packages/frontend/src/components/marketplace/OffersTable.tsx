'use client'

import { useState } from 'react'
import { Table } from '@/components/ui/Table'
import { ANY_RECIPIENT_BUDGET_NOTE, ANY_RECIPIENT_BUDGET_TAG, chainName, needsUnpinnedBudget, networkToChainId, withinBudget } from '@/lib/marketplace'
import { OfferCopyButton, OfferInstructionText, OfferMeta } from './OfferInstruction'
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
 * below (same cells, same copy, same budget hint, same labelled copy button
 * and the same rule for when the instruction is printed, #3998), so the
 * warning that prevents a declined payment is never behind a horizontal
 * scroll.
 */
function OfferCard({
  entry,
  budget,
  tagged,
}: {
  entry: CatalogEntry
  budget: boolean | null
  tagged: boolean
}) {
  const degraded = entry.status === 'degraded'
  const chainId = networkToChainId(entry.network)
  const [revealed, setRevealed] = useState(false)
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
        {tagged && (
          <span className="rounded-full bg-[var(--v2-warning-soft)] px-2 py-0.5 text-xs font-medium text-[var(--v2-warning)]">
            {ANY_RECIPIENT_BUDGET_TAG}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-[var(--v2-ink-3)]">{entry.description}</p>
      <OfferMeta entry={entry} />
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
        <dt className="text-[var(--v2-ink-3)]">Network</dt>
        <dd className="text-[var(--v2-ink-2)]">{chainId === undefined ? '—' : chainName(chainId)}</dd>
      </dl>
      <OfferInstructionText entry={entry} revealed={revealed} />
      <OfferCopyButton entry={entry} onCopyFailed={() => setRevealed(true)} className="mt-3 w-full" />
    </li>
  )
}

/**
 * The merchant page's ONE offers section (#3981, epic #3077): each offer is a
 * single row — a `Table` from `md` up, the stacked card below — carrying its
 * price, network and a labelled "Copy instruction" button (#3998). The
 * instruction itself is printed only where the user must see it: an offer
 * whose instruction has a placeholder to replace, or after a refused copy
 * (`OfferInstruction.tsx`).
 *
 * The offers on the user's own network (the chain of
 * `resolveDefaultAccount(user.accounts)`, passed as `defaultChainId`) come
 * first; offers on other networks sit behind an "Other networks (n)"
 * disclosure in BOTH shapes. When the user's default network serves none of
 * the merchant's offers, everything renders flat.
 */
export function OffersTable({
  offers,
  agents,
  defaultChainId = null,
}: {
  offers: CatalogEntry[]
  agents: Agents
  defaultChainId?: number | null
}) {
  if (offers.length === 0) return null

  const chainIdOf = (offer: CatalogEntry) => networkToChainId(offer.network)
  const here = defaultChainId === null ? [] : offers.filter((o) => chainIdOf(o) === defaultChainId)
  const others = here.length > 0 ? offers.filter((o) => chainIdOf(o) !== defaultChainId) : []
  const visible = here.length > 0 ? here : offers

  const bridgeOnly = offers.filter((o) => needsUnpinnedBudget(o.asset_transfer_methods))
  const mixed = bridgeOnly.length > 0 && bridgeOnly.length < offers.length
  const tagged = (offer: CatalogEntry) => mixed && needsUnpinnedBudget(offer.asset_transfer_methods)
  const note =
    bridgeOnly.length > 0
      ? mixed
        ? `${ANY_RECIPIENT_BUDGET_NOTE} Offers marked "${ANY_RECIPIENT_BUDGET_TAG}" need this.`
        : ANY_RECIPIENT_BUDGET_NOTE
      : null

  return (
    <div className="space-y-3">
      {note && (
        <p className="text-xs leading-relaxed text-[var(--v2-ink-2)]" data-testid="any-recipient-budget-note">
          {note}
        </p>
      )}

      <ul className="space-y-2 md:hidden" data-testid="offers-list">
        {visible.map((offer) => (
          <OfferCard key={offer.id} entry={offer} budget={withinBudget(offer, agents)} tagged={tagged(offer)} />
        ))}
        {others.length > 0 && (
          <li>
            <details data-testid="other-networks" className="rounded-lg border border-[var(--v2-border)] p-3">
              <summary className="cursor-pointer text-sm font-medium text-[var(--v2-ink)]">
                Other networks ({others.length})
              </summary>
              <ul className="mt-2 space-y-2">
                {others.map((offer) => (
                  <OfferCard key={offer.id} entry={offer} budget={withinBudget(offer, agents)} tagged={tagged(offer)} />
                ))}
              </ul>
            </details>
          </li>
        )}
      </ul>

      <div className="hidden overflow-x-auto rounded-xl border border-[var(--v2-border)] md:block" data-testid="offers-table">
        <Table className="min-w-[560px]">
          <Table.Head collapseWhenNarrow={false}>
            <tr>
              <Table.HeaderCell align="left">Offer</Table.HeaderCell>
              <Table.HeaderCell align="left">Price</Table.HeaderCell>
              <Table.HeaderCell align="left">Network</Table.HeaderCell>
              <Table.HeaderCell align="left">
                <span className="sr-only">Copy instruction</span>
              </Table.HeaderCell>
            </tr>
          </Table.Head>
          <Table.Body>
            {visible.map((offer) => (
              <OfferRow key={offer.id} entry={offer} budget={withinBudget(offer, agents)} tagged={tagged(offer)} />
            ))}
            {others.length > 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-3">
                  <details data-testid="other-networks" className="text-sm">
                    <summary className="cursor-pointer font-medium text-[var(--v2-ink)]">
                      Other networks ({others.length})
                    </summary>
                    <div className="mt-2">
                      <Table className="min-w-[560px]">
                        <Table.Body>
                          {others.map((offer) => (
                            <OfferRow
                              key={offer.id}
                              entry={offer}
                              budget={withinBudget(offer, agents)}
                              tagged={tagged(offer)}
                            />
                          ))}
                        </Table.Body>
                      </Table>
                    </div>
                  </details>
                </td>
              </tr>
            )}
          </Table.Body>
        </Table>
      </div>
    </div>
  )
}
