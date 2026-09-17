import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'

/**
 * The `/marketplace/*` not-found boundary (#3079): an unknown or hidden
 * merchant slug (`notFound()` in `[slug]/page.tsx`) lands on a designed
 * state with a way back, not Next's stock 404 inside the app shell.
 */
export default function MarketplaceNotFound() {
  return (
    <div className="max-w-5xl" data-testid="marketplace-not-found">
      <EmptyState
        tone="neutral"
        title="Merchant not found"
        body="There is no merchant at this address, or it is not listed for you."
        action={
          <Button href="/marketplace" variant="ghost" size="sm">
            Back to Marketplace
          </Button>
        }
      />
    </div>
  )
}
