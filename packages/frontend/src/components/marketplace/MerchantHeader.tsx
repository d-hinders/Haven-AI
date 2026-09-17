import { Monogram } from '@/components/ui/Monogram'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { categoryLabel, chainName, networkToChainId, VERIFIED_MEANING } from '@/lib/marketplace'
import type { Merchant } from '@/hooks/useCatalog'

export const TEST_MERCHANT_NOTE = 'Haven test merchant — real payments, demo goods'

/**
 * The merchant page's header (#3079, epic #3077) — and its one `h1`. The
 * Verified badge's meaning is VISIBLE text under the description, not a
 * tooltip: `Tooltip` is documented as "not a home for essential copy"
 * (#2017), and what "Verified" does not promise is exactly what a user needs
 * before pasting a payment instruction. A test merchant is labelled HERE,
 * where a user is one paste away from a real payment, as a wrapping line —
 * a `StatusBadge` is a one-line stadium and clipped the sentence at 390.
 */
export function MerchantHeader({ merchant }: { merchant: Merchant }) {
  const networks = merchant.networks
    .map((n) => networkToChainId(n))
    .filter((id): id is number => id !== undefined)

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex items-start gap-3">
        <Monogram name={merchant.name} logoUrl={merchant.logo_url} size="md" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="v2-text-h1 text-[var(--v2-ink)]">{merchant.name}</h1>
            {merchant.verified_payable && (
              <span title={VERIFIED_MEANING}>
                <StatusBadge tone="success" className="uppercase tracking-wide">
                  Verified
                </StatusBadge>
              </span>
            )}
          </div>
          <span className="mt-1 inline-block rounded-full bg-[var(--v2-surface-2)] px-2 py-0.5 text-xs font-medium text-[var(--v2-ink-2)]">
            {categoryLabel(merchant.category)}
          </span>
          {merchant.is_test_merchant && (
            <p className="mt-2 text-sm font-medium text-[var(--v2-warning)]" data-testid="test-merchant-note">
              {TEST_MERCHANT_NOTE}
            </p>
          )}
          <p className="mt-2 max-w-xl text-sm text-[var(--v2-ink-3)]">{merchant.description}</p>
          {merchant.verified_payable && (
            <p className="mt-1 max-w-xl text-xs text-[var(--v2-ink-3)]" data-testid="verified-meaning">
              {VERIFIED_MEANING}
            </p>
          )}
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
