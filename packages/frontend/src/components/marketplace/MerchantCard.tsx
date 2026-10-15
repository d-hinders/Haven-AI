import Link from 'next/link'
import { Check } from 'lucide-react'
import { formatTokenAmount } from '@haven_ai/core'
import { Monogram } from '@/components/ui/Monogram'
import { TEST_MERCHANT_NOTE } from './MerchantHeader'
import { Icon } from '@/components/ui/Icon'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { entityCardClassName } from '@/components/ui/entityCardStyles'
import { categoryLabel, chainName, networkToChainId, verifiedMeaning } from '@/lib/marketplace'
import type { Merchant } from '@/hooks/useCatalog'

/** USDC is 6 decimals on every chain core registers (`packages/core/src/chains.ts`). */
const USDC_DECIMALS = 6

/**
 * The lowest USDC price in human units, or null when the merchant names none —
 * the footer then falls back to the offer count alone. `price_atomic` is the
 * merchant's own advertised value, so a malformed one is a real possibility
 * rather than a shape confusion; it renders as no price at all, the same
 * defensiveness the per-offer budget answer applies
 * (`agentsThatCanPay`, `lib/marketplace.ts`).
 */
function lowestPrice(merchant: Merchant): string | null {
  if (!merchant.lowest_price_atomic) return null
  try {
    return formatTokenAmount(BigInt(merchant.lowest_price_atomic), USDC_DECIMALS)
  } catch {
    return null
  }
}

/**
 * The footer's one line (#3980): what a buyer decides on, first — "From
 * 0.001 USDC" — with the offer count after it when there is more than one
 * offer to count. A merchant with no USDC-priced offer shows the count alone;
 * a coming-soon card shows no footer at all.
 */
function footer(merchant: Merchant): string {
  const count = merchant.offer_count === 1 ? '1 offer' : `${merchant.offer_count} offers`
  const price = lowestPrice(merchant)
  if (price === null) return count
  return merchant.offer_count > 1 ? `From ${price} USDC · ${count}` : `From ${price} USDC`
}

/**
 * One merchant in the `/marketplace` grid (#3079, epic #3077). The whole card
 * is the link to the merchant page, on the shared entity-card idiom
 * (`entityCardClassName`: hover lift, the product focus ring) like `AgentCard`
 * and the accounts overview. The footer is pinned to the bottom so a row of
 * cards aligns whatever each one lists above it.
 *
 * #3980: the card answers "can I pay this, and what does it cost?" at a
 * glance. A coming-soon merchant is muted and says so in the badge slot with
 * no footer; verified is a quiet check after the name, not a green badge
 * (most cards are verified, so the badge said nothing); the category is plain
 * text so it stops dressing up like the network chips.
 */
export function MerchantCard({ merchant }: { merchant: Merchant }) {
  const networks = merchant.networks
    .map((n) => networkToChainId(n))
    .filter((id): id is number => id !== undefined)
  const comingSoon = merchant.listing_status === 'coming_soon'

  return (
    <Link
      href={`/marketplace/${merchant.slug}`}
      data-testid={`merchant-card-${merchant.slug}`}
      className={`${entityCardClassName()} flex flex-col gap-3`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <Monogram name={merchant.name} logoUrl={merchant.logo_url} />
          <div className="min-w-0">
            <h3
              className={`line-clamp-2 text-sm font-semibold ${
                comingSoon ? 'text-[var(--v2-ink-2)]' : 'text-[var(--v2-ink)]'
              }`}
            >
              {merchant.name}
              {merchant.verified_payable && (
                // A link cannot host a tooltip trigger (nested interactive); the
                // marker's meaning is spelled out on the merchant page the card
                // opens. The sr-only text is SHORT — the whole sentence would
                // become part of the card link's accessible name.
                <span
                  title={verifiedMeaning(merchant.name)}
                  className="ml-1 inline-flex items-center align-[-2px] text-[var(--v2-success)]"
                >
                  <Icon icon={Check} className="h-3.5 w-3.5" />
                  <span className="sr-only">Verified</span>
                </span>
              )}
            </h3>
            {/* Plain ink-3 text, deliberately NOT a chip: the network chips
                below stay `surface-2` pills, so the category no longer reads
                as a third network. */}
            <span className="text-xs font-medium text-[var(--v2-ink-3)]">
              {categoryLabel(merchant.category)}
            </span>
          </div>
        </div>
        {comingSoon && (
          // The badge slot: a coming-soon merchant is the one state a buyer
          // must notice before clicking through, so it keeps a badge while
          // "Verified" demotes to a check.
          <StatusBadge tone="neutral">Coming soon</StatusBadge>
        )}
      </div>

      {merchant.is_test_merchant && !comingSoon && (
        <p className="text-xs font-medium text-[var(--v2-warning)]">{TEST_MERCHANT_NOTE}</p>
      )}

      <p className="line-clamp-2 text-xs text-[var(--v2-ink-3)]">{merchant.description}</p>

      {networks.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {networks.map((id) => (
            <span
              key={id}
              className="rounded-full bg-[var(--v2-surface-2)] px-2 py-0.5 text-xs font-medium text-[var(--v2-ink-2)]"
            >
              {chainName(id)}
            </span>
          ))}
        </div>
      )}

      {/* One line, pinned: the comparable datum in a row aligns across cards.
          A coming-soon merchant has nothing comparable — no offers, no price —
          so its footer is empty rather than "0 offers". */}
      {!comingSoon && (
        <p className="mt-auto text-xs font-medium text-[var(--v2-ink-3)]">{footer(merchant)}</p>
      )}
    </Link>
  )
}
