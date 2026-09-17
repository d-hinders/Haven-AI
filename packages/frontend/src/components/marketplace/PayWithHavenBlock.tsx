'use client'

import { CopyButton } from '@/components/ui/CopyButton'
import { agentInstruction, needsUnpinnedBudget } from '@/lib/marketplace'
import type { CatalogEntry } from '@/hooks/useCatalog'

/**
 * The merchant page's "Pay this with Haven" block (#3079, epic #3077): one
 * paste-into-agent instruction per offer, with a copy button, plus the
 * EIP-3009 unpinned-budget note when an offer's `asset_transfer_methods`
 * lacks `erc7710` (`CLAUDE.md` "x402" section — the bridge requires an open
 * budget; pinned agents are erc7710-only).
 */
export function PayWithHavenBlock({ offers }: { offers: CatalogEntry[] }) {
  if (offers.length === 0) return null

  return (
    <div className="space-y-3">
      {offers.map((offer) => {
        const instruction = agentInstruction(offer)
        const bridgeOnly = needsUnpinnedBudget(offer.asset_transfer_methods)
        return (
          <div
            key={offer.id}
            className="rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface-2)] px-3 py-2.5"
          >
            <div className="flex items-center justify-between gap-2">
              <code className="min-w-0 flex-1 truncate text-xs text-[var(--v2-ink-2)]">
                {instruction}
              </code>
              <CopyButton value={instruction} label={`agent instruction for ${offer.name}`} />
            </div>
            {bridgeOnly && (
              <p className="mt-1.5 text-xs text-[var(--v2-ink-3)]">
                This merchant settles by EIP-3009 — the paying agent needs an unpinned budget.
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
