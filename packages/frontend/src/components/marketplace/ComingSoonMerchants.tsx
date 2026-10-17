import { Card } from '@/components/ui/Card'
import { Monogram } from '@/components/ui/Monogram'
import { Row } from '@/components/ui/Row'
import type { Merchant } from '@/hooks/useCatalog'

/**
 * The merchants you cannot pay yet, below the `/marketplace` grid (#4052).
 * They used to render as full cards in the payable grid — muted, badged,
 * footer-less — so the grid's rhythm carried entries with nothing to compare.
 * One titled `Card` with a divided `Row` list keeps them findable without
 * competing with the merchants a buyer can act on. Renders nothing when the
 * list is empty, so no heading stands over nothing.
 *
 * The house title-row shape `HowToBuyPanel` uses: `Card.Header` band, then a
 * `Card.Section divided` with `border-t-0` (the header's hairline is the one
 * under it). Each row still links to the merchant page, as the card did.
 * `Row` forwards no `data-testid`, so a wrapper carries `merchant-row-<slug>`.
 * Two overrides on `Row`, both later in Tailwind's order than the defaults
 * they replace: `px-5` keeps the rows on the header's inset, and
 * `leadingClassName` sizes the toneless 16px leading box to the 36px Monogram.
 */
export function ComingSoonMerchants({ merchants }: { merchants: Merchant[] }) {
  if (merchants.length === 0) return null
  return (
    <div data-testid="marketplace-coming-soon">
      <Card hover={false} className="overflow-hidden">
        <Card.Header as="h2" title="Coming soon" description="Not payable through Haven yet." />
        <Card.Section divided className="border-t-0">
          {merchants.map((merchant) => (
            <div key={merchant.id} data-testid={`merchant-row-${merchant.slug}`}>
              <Row
                href={`/marketplace/${merchant.slug}`}
                className="px-5"
                leading={<Monogram name={merchant.name} logoUrl={merchant.logo_url} />}
                leadingClassName="h-9 w-9"
                title={merchant.name}
                subtitle={merchant.description}
              />
            </div>
          ))}
        </Card.Section>
      </Card>
    </div>
  )
}
