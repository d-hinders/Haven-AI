import Link from 'next/link'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { chainName, merchantInitials, networkToChainId } from '@/lib/marketplace'
import type { Merchant } from '@/hooks/useCatalog'

/** Monogram or logo, same pattern the `/contacts` `Initials` avatar uses. Only Haven-run and Ampersend rows ever carry a `logo_url` — a prospect never does. */
function MerchantMonogram({ merchant }: { merchant: Merchant }) {
  if (merchant.logo_url) {
    // eslint-disable-next-line @next/next/no-img-element -- external merchant
    // logos are not known ahead of time, so next/image's static domain
    // allowlist would have to widen per merchant; a plain <img> avoids that.
    return (
      <img
        src={merchant.logo_url}
        alt=""
        className="h-9 w-9 flex-shrink-0 rounded-full border border-[var(--v2-border)] object-cover"
      />
    )
  }
  return (
    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-brand/20 bg-[var(--v2-brand-soft)]">
      <span className="text-xs font-semibold text-[var(--v2-brand)]">
        {merchantInitials(merchant.name)}
      </span>
    </div>
  )
}

function footerLabel(merchant: Merchant): string {
  if (merchant.listing_status === 'coming_soon') return 'Coming soon'
  if (merchant.is_test_merchant) return 'Haven test merchant — real payments, demo goods'
  return merchant.offer_count === 1 ? '1 offer' : `${merchant.offer_count} offers`
}

export function MerchantCard({ merchant }: { merchant: Merchant }) {
  const networks = merchant.networks
    .map((n) => networkToChainId(n))
    .filter((id): id is number => id !== undefined)

  return (
    <Link
      href={`/marketplace/${merchant.slug}`}
      data-testid={`merchant-card-${merchant.slug}`}
      className="flex flex-col gap-3 rounded-xl border border-[var(--v2-border)] bg-[var(--v2-bg)] p-4 transition-colors hover:border-brand/30"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <MerchantMonogram merchant={merchant} />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-[var(--v2-ink)]">
              {merchant.name}
            </h3>
            <span className="rounded-full bg-[var(--v2-surface-2)] px-2 py-0.5 text-xs font-medium capitalize text-[var(--v2-ink-2)]">
              {merchant.category}
            </span>
          </div>
        </div>
        {merchant.verified_payable && (
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

      <p className="text-xs font-medium text-[var(--v2-ink-3)]">{footerLabel(merchant)}</p>
    </Link>
  )
}
