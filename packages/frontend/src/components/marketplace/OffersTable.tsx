'use client'

import { useState } from 'react'
import { Table } from '@/components/ui/Table'
import { ANY_RECIPIENT_BUDGET_TAG, agentsThatCanPay, budgetAnswerLine, chainName, needsUnpinnedBudget, networkToChainId, type BudgetAgent } from '@/lib/marketplace'
import { OfferCopyButton, OfferInstructionText, OfferMeta } from './OfferInstruction'
import { OfferRow } from './OfferRow'
import type { CatalogEntry, MerchantFundingTarget } from '@/hooks/useCatalog'
import type { DashboardBudgetRemainingEntry } from '@/hooks/useBudgetRemaining'
import type { MerchantBudget } from '@/hooks/useMerchantBudgets'

/** One row's budget answer: the line and its tone, or null when nothing is known. */
export type OfferBudgetHint = { text: string; tone: 'can' | 'cannot' } | null

function BudgetHint({ budget }: { budget: OfferBudgetHint }) {
  if (!budget) return null
  return (
    <p className={`mt-0.5 text-xs font-medium ${budget.tone === 'can' ? 'text-[var(--v2-success)]' : 'text-[var(--v2-warning)]'}`}>
      {budget.text}
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
  copiedText,
}: {
  entry: CatalogEntry
  budget: OfferBudgetHint
  tagged: boolean
  /** Set when exactly one agent can pay this offer — the confirmation names it (#4005). */
  copiedText?: string | null
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
      <OfferCopyButton entry={entry} copiedText={copiedText} onCopyFailed={() => setRevealed(true)} className="mt-3 w-full" />
    </li>
  )
}

/**
 * #4008: ONE shared column layout for the merchant page's desktop offers
 * table and the nested "Other networks" table inside its disclosure.
 *
 * The disclosure renders a second `Table` inside a `colSpan={4}` cell, and
 * on dev its columns sized on their own — auto layout over different
 * content — so the nested cells' left edges sat up to 16px off the outer
 * table's (measured at 1280: 273/744/889/1022 vs 289/737/898/982). Both
 * tables therefore carry `table-fixed` and THIS `colgroup`, so their columns
 * are decided by the same declaration rather than by their own rows. Merging
 * the rows into one table is not an option: `<details>` cannot wrap `<tr>`s,
 * and the #3998 structural test asserts the nested table. The proportions
 * follow the auto layout the outer table had on dev (≈48.75/15/13.75/22.5),
 * so the change is alignment, not a new look.
 */
const OFFER_COLUMN_LAYOUT = (
  <colgroup>
    <col className="w-[48.75%]" />
    <col className="w-[15%]" />
    <col className="w-[13.75%]" />
    <col className="w-[22.5%]" />
  </colgroup>
)

/**
 * The merchant page's ONE offers section (#3981, epic #3077): each offer is a
 * single row — a `Table` from `md` up, the stacked card below — carrying its
 * price, network and a labelled "Copy prompt" button (#3998, #4003 wording).
 * The
 * instruction itself is printed only where the user must see it: an offer
 * whose instruction has a placeholder to replace, or after a refused copy
 * (`OfferInstruction.tsx`).
 *
 * The offers on the user's own network (the chain of
 * `resolveDefaultAccount(user.accounts)`, passed as `defaultChainId`) come
 * first; offers on other networks sit behind an "n more on <chain names>"
 * disclosure in BOTH shapes. When the user's default network serves none of
 * the merchant's offers, everything renders flat.
 */
export function OffersTable({
  offers,
  agents,
  budgets = [],
  merchantBudgets = [],
  funding = [],
  defaultChainId = null,
}: {
  offers: CatalogEntry[]
  /** The spec-derived agent shape `agentsThatCanPay` reads (#4004). */
  agents: BudgetAgent[]
  /** `GET /dashboard/budget-remaining` rows — what is LEFT, per agent and budget. */
  budgets?: DashboardBudgetRemainingEntry[]
  /** `GET /merchants/{slug}/budgets` rows — the merchant-locked budgets. */
  merchantBudgets?: MerchantBudget[]
  /** The merchant's funding targets — the verified pay-to a locked budget pins. */
  funding?: MerchantFundingTarget[]
  defaultChainId?: number | null
}) {
  if (offers.length === 0) return null

  // One answer per offer, shared by the table row and the phone card — the
  // two shapes must never disagree about who can pay (#4004). The same
  // answers drive the #4005 copy confirmation: when exactly one agent can
  // pay an offer, its button names that agent once copied.
  const answersFor = (offer: CatalogEntry) =>
    agentsThatCanPay({ offer, agents, budgets, merchantBudgets, funding })
  const perOffer = new Map(offers.map((offer) => [offer.id, answersFor(offer)]))
  const hintFor = (offer: CatalogEntry): OfferBudgetHint => {
    const answers = perOffer.get(offer.id)!
    const text = budgetAnswerLine(answers)
    if (!text) return null
    return { text, tone: answers.some((a) => a.answer === 'can') ? 'can' : 'cannot' }
  }
  const copiedTextFor = (offer: CatalogEntry): string | null => {
    const cans = perOffer.get(offer.id)!.filter((a) => a.answer === 'can')
    return cans.length === 1 ? `Copied — paste it to ${cans[0]!.agentName}` : null
  }

  const chainIdOf = (offer: CatalogEntry) => networkToChainId(offer.network)
  const here = defaultChainId === null ? [] : offers.filter((o) => chainIdOf(o) === defaultChainId)
  const others = here.length > 0 ? offers.filter((o) => chainIdOf(o) !== defaultChainId) : []
  const visible = here.length > 0 ? here : offers

  // #4003's one predicate: the disclosure names the hidden chains, and adds
  // "— none of your agents can pay on that network" ONLY when no active
  // agent's account chain is among them. The SPLIT above is by the default
  // account, but an agent can sit on any account — a user with a second
  // account may still have an agent that can pay on a hidden network, and
  // then the warning must not fire.
  const hiddenChainIds = Array.from(
    new Set(others.map((o) => chainIdOf(o)).filter((id): id is number => id !== undefined)),
  )
  const agentChainIds = new Set(
    agents.filter((a) => a.status === 'active' && a.account_chain_id !== null).map((a) => a.account_chain_id),
  )
  const noAgentCanPayHidden = !hiddenChainIds.some((id) => agentChainIds.has(id))
  const disclosure =
    `${others.length} more on ${hiddenChainIds.map(chainName).join(', ')}` +
    (noAgentCanPayHidden ? ' — none of your agents can pay on that network' : '')

  const bridgeOnly = offers.filter((o) => needsUnpinnedBudget(o.asset_transfer_methods))
  const mixed = bridgeOnly.length > 0 && bridgeOnly.length < offers.length
  const tagged = (offer: CatalogEntry) => mixed && needsUnpinnedBudget(offer.asset_transfer_methods)
  // #4005: the any-recipient NOTE is no longer a paragraph above the table —
  // the "How to buy" panel's step 2 carries it in plain words, next to the
  // state that makes it matter. The per-offer TAG stays on the rows that
  // need it in a mixed merchant.

  return (
    <div className="space-y-3">
      <ul className="space-y-2 md:hidden" data-testid="offers-list">
        {visible.map((offer) => (
          <OfferCard
            key={offer.id}
            entry={offer}
            budget={hintFor(offer)}
            tagged={tagged(offer)}
            copiedText={copiedTextFor(offer)}
          />
        ))}
        {others.length > 0 && (
          <li>
            <details data-testid="other-networks" className="rounded-lg border border-[var(--v2-border)] p-3">
              <summary className="cursor-pointer text-sm font-medium text-[var(--v2-ink)]">
                {disclosure}
              </summary>
              <ul className="mt-2 space-y-2">
                {others.map((offer) => (
                  <OfferCard
                    key={offer.id}
                    entry={offer}
                    budget={hintFor(offer)}
                    tagged={tagged(offer)}
                    copiedText={copiedTextFor(offer)}
                  />
                ))}
              </ul>
            </details>
          </li>
        )}
      </ul>

      <div className="hidden overflow-x-auto rounded-xl border border-[var(--v2-border)] md:block" data-testid="offers-table">
        <Table className="min-w-[560px] table-fixed">
          {OFFER_COLUMN_LAYOUT}
          <Table.Head collapseWhenNarrow={false}>
            <tr>
              <Table.HeaderCell align="left">Offer</Table.HeaderCell>
              <Table.HeaderCell align="left">Price</Table.HeaderCell>
              <Table.HeaderCell align="left">Network</Table.HeaderCell>
              <Table.HeaderCell align="left">
                <span className="sr-only">Copy prompt</span>
              </Table.HeaderCell>
            </tr>
          </Table.Head>
          <Table.Body>
            {visible.map((offer) => (
              <OfferRow
                key={offer.id}
                entry={offer}
                budget={hintFor(offer)}
                tagged={tagged(offer)}
                copiedText={copiedTextFor(offer)}
              />
            ))}
            {others.length > 0 && (
              <tr>
                <td colSpan={4} className="py-3">
                  {/* #4008: no horizontal padding here — the nested table
                      spans the row's full width, so its `table-fixed` +
                      shared `colgroup` lines its columns up with the outer
                      table's (the Offer cells' own `px-4` insets match).
                      With `px-4` the nested table was offset by the cell's
                      own gutter AND sized on its own content. */}
                  <details data-testid="other-networks" className="text-sm">
                    <summary className="cursor-pointer font-medium text-[var(--v2-ink)]">
                      {disclosure}
                    </summary>
                    <div className="mt-2">
                      <Table className="table-fixed">
                        {OFFER_COLUMN_LAYOUT}
                        <Table.Body>
                          {others.map((offer) => (
                            <OfferRow
                              key={offer.id}
                              entry={offer}
                              budget={hintFor(offer)}
                              tagged={tagged(offer)}
                              copiedText={copiedTextFor(offer)}
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
