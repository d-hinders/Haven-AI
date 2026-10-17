import Link from 'next/link'
import { Check } from 'lucide-react'
import { Monogram } from '@/components/ui/Monogram'
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
 *
 * #4008: ONE number format for prices on Haven's frontend. The card used to
 * run core's `formatTokenAmount`, which trims trailing zeros to one fractional
 * digit ("0.1", "1.0") while the offer row's `price_display` — the backend's
 * `formatPriceDisplay` — pads to at least two ("0.10", "1.00"). The card now
 * applies the backend's rule (mirror of `merchant-catalog.ts`: pad out, split
 * on the decimals, trim trailing zeros, then pad the fraction to TWO), so
 * both surfaces read the same string. `price_display` itself is untouched on
 * the wire — the MCP tools, `packages/mcp`, the CLI and the SDK read it.
 */
function lowestPrice(merchant: Merchant): string | null {
  const atomic = merchant.lowest_price_atomic
  if (!atomic || !/^[0-9]+$/.test(atomic)) return null
  const padded = atomic.padStart(USDC_DECIMALS + 1, '0')
  const intPart = padded.slice(0, padded.length - USDC_DECIMALS)
  const frac = padded.slice(padded.length - USDC_DECIMALS).replace(/0+$/, '').padEnd(2, '0')
  return `${intPart}.${frac}`
}

/**
 * The footer's one line (#3980): what a buyer decides on, first — "From
 * 0.001 USDC" — with the offer count after it when there is more than one
 * offer to count. A merchant with no USDC-priced offer shows the count alone.
 *
 * #4052: the price leads in ink and semibold, the count stays ink-3 — the
 * price is the datum a buyer compares across cards, the count is context.
 */
function Footer({ merchant }: { merchant: Merchant }) {
  const count = merchant.offer_count === 1 ? '1 offer' : `${merchant.offer_count} offers`
  const price = lowestPrice(merchant)
  return (
    <p className="mt-auto text-xs font-medium text-[var(--v2-ink-3)]">
      {price === null ? (
        count
      ) : (
        <>
          <span className="font-semibold text-[var(--v2-ink)]">From {price} USDC</span>
          {merchant.offer_count > 1 && <span> · {count}</span>}
        </>
      )}
    </p>
  )
}

/**
 * One merchant in the `/marketplace` grid (#3079, epic #3077). The whole card
 * is the link to the merchant page, on the shared entity-card idiom
 * (`entityCardClassName`: hover lift, the product focus ring) like `AgentCard`
 * and the accounts overview. The footer is pinned to the bottom so a row of
 * cards aligns whatever each one lists above it.
 *
 * #3980: the card answers "can I pay this, and what does it cost?" at a
 * glance. Verified is a quiet check after the name — since #4008 the ONE
 * Verified treatment: the merchant header carries the same check plus the
 * word in sentence case, and no surface renders an ALL-CAPS badge any more
 * (the category is plain text so it stops dressing up like the network
 * chips).
 *
 * #4052: only payable merchants get a card — coming-soon ones list below the
 * grid in `ComingSoonMerchants`. A test merchant carries a neutral "Test"
 * badge in the badge slot; the full "payments are real, goods are demo"
 * sentence lives on the merchant page (`MerchantHeader`), where the user is
 * one paste away from paying.
 */
export function MerchantCard({ merchant }: { merchant: Merchant }) {
  const networks = merchant.networks
    .map((n) => networkToChainId(n))
    .filter((id): id is number => id !== undefined)

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
            <h3 className="line-clamp-2 text-sm font-semibold text-[var(--v2-ink)]">
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
        {merchant.is_test_merchant && (
          // The badge slot: neutral, not warning — the merchant page carries
          // the full sentence, so the grid only needs to mark which is which.
          <StatusBadge tone="neutral">Test</StatusBadge>
        )}
      </div>

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

      {/* One line, pinned: the comparable datum in a row aligns across cards. */}
      <Footer merchant={merchant} />
    </Link>
  )
}
