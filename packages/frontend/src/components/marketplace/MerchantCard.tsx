import Link from 'next/link'
import { Monogram } from '@/components/ui/Monogram'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { entityCardClassName } from '@/components/ui/entityCardStyles'
import { categoryLabel, chainName, networkToChainId } from '@/lib/marketplace'
import type { Merchant } from '@/hooks/useCatalog'

function offerCount(merchant: Merchant): string {
  return merchant.offer_count === 1 ? '1 offer' : `${merchant.offer_count} offers`
}

/**
 * One merchant in the `/marketplace` grid (#3079, epic #3077). The whole card
 * is the link to the merchant page, on the shared entity-card idiom
 * (`entityCardClassName`: hover lift, the product focus ring) like `AgentCard`
 * and the accounts overview. The footer is pinned to the bottom so a row of
 * cards aligns whatever each one lists above it.
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
            <h3 className="truncate text-sm font-semibold text-[var(--v2-ink)]">
              {merchant.name}
            </h3>
            <span className="rounded-full bg-[var(--v2-surface-2)] px-2 py-0.5 text-xs font-medium text-[var(--v2-ink-2)]">
              {categoryLabel(merchant.category)}
            </span>
          </div>
        </div>
        {merchant.verified_payable && (
          // A link cannot host a tooltip trigger (nested interactive); the
          // badge's meaning is spelled out on the merchant page the card opens.
          <span title="Domain controlled and verified payable">
            <StatusBadge tone="success" className="uppercase tracking-wide">
              Verified
            </StatusBadge>
          </span>
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

      <div className="mt-auto space-y-1 text-xs font-medium text-[var(--v2-ink-3)]">
        <p>{comingSoon ? 'Coming soon' : offerCount(merchant)}</p>
        {merchant.is_test_merchant && !comingSoon && (
          <p className="text-[var(--v2-warning)]">Haven test merchant — real payments, demo goods</p>
        )}
      </div>
    </Link>
  )
}
