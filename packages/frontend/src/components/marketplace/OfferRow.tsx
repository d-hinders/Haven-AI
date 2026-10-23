'use client'

import { useState } from 'react'
import { ANY_RECIPIENT_BUDGET_TAG, chainName, networkToChainId } from '@/lib/marketplace'
import { OfferCopyButton, OfferInstructionText, OfferMeta } from './OfferInstruction'
import type { OfferBudgetHint } from './OffersTable'
import type { CatalogEntry } from '@/hooks/useCatalog'

/**
 * One offer's row in the merchant page's single offers list (#3981, epic
 * #3978): no Method column and no per-row Verified marker (the merchant-level
 * check-plus-word in `MerchantHeader` is the trust claim, #4008). Since #3998
 * it is ONE table row: the instruction is no longer printed as a second row —
 * the labelled "Copy prompt" button copies it byte-for-byte, and the Offer
 * cell prints it only when the user must edit it or the clipboard refused it
 * (`OfferInstructionText`).
 */
export function OfferRow({
  entry,
  budget,
  tagged,
  copiedText,
}: {
  entry: CatalogEntry
  /** The shared per-offer budget answer (`OffersTable`'s hint map, #4004). */
  budget: OfferBudgetHint
  tagged: boolean
  /** Set when exactly one agent can pay this offer — the confirmation names it (#4005). */
  copiedText?: string | null
}) {
  const degraded = entry.status === 'degraded'
  const chainId = networkToChainId(entry.network)
  const [revealed, setRevealed] = useState(false)

  return (
      <tr data-testid={`offer-row-${entry.id}`}>
        <td className="px-4 py-3 align-top">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-[var(--v2-ink)]">{entry.name}</span>
            {degraded ? (
              <span className="rounded-full bg-[var(--v2-warning-soft)] px-2 py-0.5 text-xs font-medium text-[var(--v2-warning)]">
                Limited availability
              </span>
            ) : null}
            {tagged ? (
              <span className="rounded-full bg-[var(--v2-warning-soft)] px-2 py-0.5 text-xs font-medium text-[var(--v2-warning)]">
                {ANY_RECIPIENT_BUDGET_TAG}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]">{entry.description}</p>
          <OfferMeta entry={entry} />
          <OfferInstructionText entry={entry} revealed={revealed} />
          {degraded ? (
            <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
              Recently unreachable on our checks — a payment may need a retry until it recovers.
            </p>
          ) : null}
        </td>
        <td className="px-4 py-3 align-top">
          <span className="v2-tabular text-sm font-semibold text-[var(--v2-ink)]">
            {entry.price_display ?? 'Price on request'}
          </span>
          {budget !== null && (
            <p
              className={`mt-0.5 text-xs font-medium ${
                budget.tone === 'can' ? 'text-[var(--v2-success)]' : 'text-[var(--v2-warning)]'
              }`}
            >
              {budget.text}
            </p>
          )}
        </td>
        <td className="whitespace-nowrap px-4 py-3 align-top text-xs text-[var(--v2-ink-2)]">
          {chainId === undefined ? '—' : chainName(chainId)}
        </td>
        <td className="px-4 py-3 text-right align-top">
          {/* No `whitespace-nowrap` here: the resting label is short, and the
              #4005 confirmation ("Copied — paste it to <agent>") is longer —
              it must wrap cleanly in the cell rather than widen the row. */}
          <OfferCopyButton entry={entry} copiedText={copiedText} onCopyFailed={() => setRevealed(true)} />
        </td>
      </tr>
  )
}
