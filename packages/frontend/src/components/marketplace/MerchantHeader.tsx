import { Monogram } from '@/components/ui/Monogram'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Tooltip } from '@/components/ui/Tooltip'
import { categoryLabel, chainName, networkToChainId, VERIFIED_MEANING } from '@/lib/marketplace'
import type { Merchant } from '@/hooks/useCatalog'

/**
 * The merchant page's header (#3079, epic #3077) — and its one `h1`. The
 * Verified badge's meaning is reachable by hover, focus and tap (`Tooltip`),
 * not only by a native `title`: the word promises more than the proof does.
 * A test merchant is labelled HERE, where a user is one paste away from a
 * real payment, not only on the grid card (decision 6).
 */
export function MerchantHeader({ merchant }: { merchant: Merchant }) {
  const networks = merchant.networks
    .map((n) => networkToChainId(n))
    .filter((id): id is number => id !== undefined)

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex items-start gap-3">
        <Monogram name={merchant.name} logoUrl={merchant.logo_url} size="md" />
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="v2-text-h1 text-[var(--v2-ink)]">{merchant.name}</h1>
            {merchant.verified_payable && (
              <Tooltip label={VERIFIED_MEANING}>
                <span>
                  <StatusBadge tone="success" className="uppercase tracking-wide">
                    Verified
                  </StatusBadge>
                </span>
              </Tooltip>
            )}
            {merchant.is_test_merchant && (
              <StatusBadge tone="warning">Haven test merchant — real payments, demo goods</StatusBadge>
            )}
          </div>
          <span className="mt-1 inline-block rounded-full bg-[var(--v2-surface-2)] px-2 py-0.5 text-xs font-medium text-[var(--v2-ink-2)]">
            {categoryLabel(merchant.category)}
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
