import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Monogram } from '@/components/ui/Monogram'
import { categoryLabel, chainName, networkToChainId, verifiedMeaning } from '@/lib/marketplace'
import type { Merchant } from '@/hooks/useCatalog'

export const TEST_MERCHANT_NOTE =
  'A Haven test merchant: payments are real (small amounts of USDC), but what you get is demo content.'

/**
 * The merchant page's header (#3079, epic #3077) — and its one `h1`. The
 * Verified badge's meaning is VISIBLE text under the description, not a
 * tooltip: `Tooltip` is documented as "not a home for essential copy"
 * (#2017), and what "Verified" does not promise is exactly what a user needs
 * before pasting a payment instruction. A test merchant is labelled HERE,
 * where a user is one paste away from a real payment, as a wrapping line —
 * a `StatusBadge` is a one-line stadium and clipped the sentence at 390.
 *
 * #3981: the shared `PageHeader` cannot hold the Monogram/logo, its `title`
 * is a plain string with no badge slot, and its `subtitle`/`meta` render
 * inside a `<p>` (the chips and warning paragraphs would be invalid nesting)
 * — so the header STAYS, aligned with `PageHeader`'s type scale and spacing,
 * and gains its `actions` slot: "Set a budget for this merchant" renders on
 * the right, the way `PageHeader` places actions (#4003 wording).
 *
 * #4015: the actions sit BELOW the text until `xl` (1280px) — at 1024 the
 * side-by-side row left the merchant's text about 262px — and the text
 * column takes the free width (`min-w-0 flex-1`) when they share a row.
 * `marketplace-header-measure.spec.ts` pins the text column's share.
 */
export function MerchantHeader({ merchant, actions }: { merchant: Merchant; actions?: ReactNode }) {
  const networks = merchant.networks
    .map((n) => networkToChainId(n))
    .filter((id): id is number => id !== undefined)

  return (
    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Monogram name={merchant.name} logoUrl={merchant.logo_url} size="md" />
        <div className="min-w-0" data-testid="merchant-header-text">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="v2-text-h1 text-[var(--v2-ink)]">{merchant.name}</h1>
            {merchant.verified_payable && (
              // #4008: ONE Verified treatment — the grid card's quiet check
              // (#3980) plus the word, in sentence case, here too. The old
              // `StatusBadge` rendered an ALL-CAPS "VERIFIED" stadium, a
              // different-looking claim for the same proof. The visible
              // meaning line below stays; `title` carries it for AT.
              <span
                title={verifiedMeaning(merchant.name)}
                data-testid="verified-marker"
                className="inline-flex items-center gap-1 text-sm font-medium text-[var(--v2-success)]"
              >
                <Icon icon={Check} className="h-3.5 w-3.5" />
                <span>Verified</span>
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
          <p className="mt-2 max-w-2xl v2-text-body text-[var(--v2-ink-2)]">{merchant.description}</p>
          {merchant.verified_payable && (
            <p className="mt-2 max-w-2xl v2-text-meta text-[var(--v2-ink-3)]" data-testid="verified-meaning">
              {verifiedMeaning(merchant.name)}
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
      {actions && <div className="flex flex-shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
