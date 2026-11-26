'use client'

import {
  MERCHANT_KIT_PILOT_LINE,
  MERCHANT_KIT_README_URL,
  MERCHANT_KIT_SENTENCE,
  SELLER_DEFINITION,
  SELLING_WITHOUT_KIT_URL,
} from '@/lib/i18n/messages/en'

/**
 * What a seller is, and the merchant kit as one option (#4985).
 *
 * The owner widened #4985 on 2026-11-19: the merchant kit is one way to sell,
 * not the only one. A merchant's own MCP server or API is a seller too, so the
 * Sales page introduces the seller first and names the merchant kit as one
 * option — never the assumption. The sentences live in `en.ts`
 * (`SELLER_DEFINITION` and the merchant kit's own sentence) so #4983's Settings
 * description and this block cannot drift.
 *
 * Rendered FIRST on the first-run helper and on the Setup tab, before any other
 * occurrence of "seller" or "kit" in that view. The pilot line applies to the
 * merchant kit, and both links are the merchant kit's own: its setup guide, and
 * the architecture doc's "Selling without the kit" section.
 */
export function SellerDefinition({ className = '' }: { className?: string }) {
  return (
    <div className={className} data-testid="seller-definition">
      <p className="text-sm leading-relaxed text-[var(--v2-ink-2)]">
        {SELLER_DEFINITION} {MERCHANT_KIT_SENTENCE}
      </p>
      {/* text-pretty (#5026): at phone width this line ended in a one-word
          "it."; `text-wrap: pretty` rebalances the last lines instead. */}
      <p className="mt-2 text-pretty text-xs leading-relaxed text-[var(--v2-ink-3)]">{MERCHANT_KIT_PILOT_LINE}</p>
      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <a
          href={MERCHANT_KIT_README_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)]"
        >
          Read the kit setup guide
        </a>
        <a
          href={SELLING_WITHOUT_KIT_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)]"
        >
          Selling without the kit
        </a>
      </p>
    </div>
  )
}

export default SellerDefinition
