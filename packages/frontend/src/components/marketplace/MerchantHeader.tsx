import { StatusBadge } from '@/components/ui/StatusBadge'
import { chainName, merchantInitials, networkToChainId } from '@/lib/marketplace'
import type { Merchant } from '@/hooks/useCatalog'

function MerchantMonogram({ merchant }: { merchant: Merchant }) {
  if (merchant.logo_url) {
    // eslint-disable-next-line @next/next/no-img-element -- external merchant
    // logos are not known ahead of time; see the identical note on
    // `MerchantCard.tsx`.
    return (
      <img
        src={merchant.logo_url}
        alt=""
        className="h-12 w-12 flex-shrink-0 rounded-full border border-[var(--v2-border)] object-cover"
      />
    )
  }
  return (
    <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full border border-brand/20 bg-[var(--v2-brand-soft)]">
      <span className="text-sm font-semibold text-[var(--v2-brand)]">
        {merchantInitials(merchant.name)}
      </span>
    </div>
  )
}

export function MerchantHeader({ merchant }: { merchant: Merchant }) {
  const networks = merchant.networks
    .map((n) => networkToChainId(n))
    .filter((id): id is number => id !== undefined)

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex items-start gap-3">
        <MerchantMonogram merchant={merchant} />
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold text-[var(--v2-ink)]">{merchant.name}</h1>
            {merchant.verified_payable && (
              <span title="Domain controlled and verified payable">
                <StatusBadge tone="success" className="uppercase tracking-wide">
                  Verified
                </StatusBadge>
              </span>
            )}
          </div>
          <span className="mt-1 inline-block rounded-full bg-[var(--v2-surface-2)] px-2 py-0.5 text-xs font-medium capitalize text-[var(--v2-ink-2)]">
            {merchant.category}
          </span>
          <p className="mt-2 max-w-xl text-sm text-[var(--v2-ink-3)]">{merchant.description}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {merchant.website && (
              <a
                href={merchant.website}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-medium text-[var(--v2-brand)] hover:underline"
              >
                {merchant.website.replace(/^https?:\/\//, '')}
              </a>
            )}
            {networks.map((id) => (
              <span
                key={id}
                className="rounded-full bg-[var(--v2-surface-2)] px-2 py-0.5 text-xs font-medium text-[var(--v2-ink-2)]"
              >
                {chainName(id)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
