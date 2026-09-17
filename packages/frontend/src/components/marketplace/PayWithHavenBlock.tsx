'use client'

import { CopyButton } from '@/components/ui/CopyButton'
import { agentInstruction, needsUnpinnedBudget } from '@/lib/marketplace'
import type { CatalogEntry } from '@/hooks/useCatalog'

export const UNPINNED_BUDGET_NOTE =
  'This merchant settles by EIP-3009 — the paying agent needs an unpinned budget.'

/**
 * The merchant page's "Pay this with Haven" block (#3079, epic #3077): one
 * paste-into-agent instruction per offer, each LABELLED with the offer it
 * pays for and printed in full — this text becomes a payment, so it wraps
 * rather than truncates (the copy button carries the same full string). The
 * EIP-3009 unpinned-budget note (`CLAUDE.md` "x402": the bridge requires an
 * open budget; pinned agents are erc7710-only) is a merchant-level fact,
 * rendered ONCE; when only some offers need it, those offers are tagged.
 */
export function PayWithHavenBlock({ offers }: { offers: CatalogEntry[] }) {
  if (offers.length === 0) return null
  const bridgeOnly = offers.filter((o) => needsUnpinnedBudget(o.asset_transfer_methods))
  const mixed = bridgeOnly.length > 0 && bridgeOnly.length < offers.length

  return (
    <div className="space-y-3">
      {bridgeOnly.length > 0 && (
        <p className="text-xs text-[var(--v2-ink-3)]">
          {mixed ? `${UNPINNED_BUDGET_NOTE} Offers marked "unpinned budget" are the ones.` : UNPINNED_BUDGET_NOTE}
        </p>
      )}
      {offers.map((offer) => {
        const instruction = agentInstruction(offer)
        const tagged = mixed && needsUnpinnedBudget(offer.asset_transfer_methods)
        return (
          <div
            key={offer.id}
            data-testid={`pay-block-${offer.id}`}
            className="rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface-2)] px-3 py-2.5"
          >
            <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              <span className="font-medium text-[var(--v2-ink)]">{offer.name}</span>
              {offer.price_display && <span className="v2-tabular text-[var(--v2-ink-2)]">{offer.price_display}</span>}
              {tagged && (
                <span className="rounded-full bg-[var(--v2-warning-soft)] px-2 py-0.5 font-medium text-[var(--v2-warning)]">
                  unpinned budget
                </span>
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <code className="min-w-0 flex-1 whitespace-pre-wrap break-all text-xs text-[var(--v2-ink-2)]">
                {instruction}
              </code>
              <CopyButton value={instruction} label={`agent instruction for ${offer.name}`} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
