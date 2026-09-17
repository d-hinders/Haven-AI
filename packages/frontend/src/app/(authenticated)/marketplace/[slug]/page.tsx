'use client'

import { useState } from 'react'
import { AlertTriangle, ChevronLeft } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { notFound as nextNotFound, useParams } from 'next/navigation'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { Button } from '@/components/ui/Button'
import { MerchantHeader } from '@/components/marketplace/MerchantHeader'
import { OffersTable } from '@/components/marketplace/OffersTable'
import { PayWithHavenBlock } from '@/components/marketplace/PayWithHavenBlock'
import CatalogSubmitModal from '@/components/CatalogSubmitModal'
import { useAgents } from '@/hooks/useAgents'
import { useMerchant } from '@/hooks/useCatalog'

/**
 * The way back on a phone, where Marketplace lives in the More drawer —
 * rendered by EVERY branch of the page (loading, error, merchant-less,
 * success), the `Button` primitive (44 px hit area, focus ring), the same
 * shape as the sweep page's "Back to agent".
 */
function BackToMarketplace() {
  return (
    <div className="mb-4">
      <Button href="/marketplace" variant="tertiary" size="sm" className="-ml-3">
        <Icon icon={ChevronLeft} className="h-3.5 w-3.5" />
        Back to Marketplace
      </Button>
    </div>
  )
}

export default function MerchantPage() {
  const params = useParams<{ slug: string }>()
  const slug = params.slug
  const { merchant, offers, loading, error, notFound, refetch } = useMerchant(slug)
  const { agents } = useAgents()
  const [submitOpen, setSubmitOpen] = useState(false)

  if (loading) {
    return (
      // `aria-busy` + `role="status"`: the skeletons are aria-hidden, so the
      // capture harness's content floor must not certify this frame (and a
      // screen reader must hear that the merchant is still loading).
      <div className="max-w-5xl space-y-4" role="status" aria-busy="true" aria-label="Loading merchant">
        <BackToMarketplace />
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    )
  }

  if (notFound) {
    // A merchant page 404s the same way an unknown route would — nextNotFound()
    // renders the app's not-found boundary rather than a bespoke empty state,
    // so an unknown slug and an unknown URL read identically to the user.
    nextNotFound()
  }

  if (error) {
    return (
      <div className="max-w-5xl">
        <BackToMarketplace />
        <EmptyState
          icon={<Icon icon={AlertTriangle} className="h-5 w-5" />}
          tone="danger"
          title="Could not load this merchant"
          body={error}
          action={
            <Button variant="ghost" size="sm" onClick={() => void refetch()}>
              Try again
            </Button>
          }
        />
      </div>
    )
  }

  if (!merchant) {
    // A 200 without a merchant body is neither a 404 nor a transport error;
    // it is still a state a user can land on, so it is designed, not blank.
    return (
      <div className="max-w-5xl">
        <BackToMarketplace />
        <EmptyState
          icon={<Icon icon={AlertTriangle} className="h-5 w-5" />}
          tone="danger"
          title="Could not load this merchant"
          body="The merchant answered without a listing."
          action={
            <Button variant="ghost" size="sm" onClick={() => void refetch()}>
              Try again
            </Button>
          }
        />
      </div>
    )
  }

  const comingSoon = merchant.listing_status === 'coming_soon'

  return (
    <div className="max-w-5xl space-y-6" data-testid="merchant-page">
      <BackToMarketplace />
      {/* The merchant header IS the page header — one h1 (a second `PageHeader`
          made the name two headings, which the visual spec's anchor refused). */}
      <MerchantHeader merchant={merchant} />

      {comingSoon ? (
        <EmptyState
          title="Coming soon — not payable yet"
          body="This merchant is not listed for payment yet."
        />
      ) : offers.length === 0 ? (
        <EmptyState
          title="No offers listed yet"
          body="This merchant has no payable offers on the networks you can reach right now."
        />
      ) : (
        <>
          <section>
            <h2 className="mb-2 text-sm font-semibold text-[var(--v2-ink)]">Pay this with Haven</h2>
            <PayWithHavenBlock offers={offers} />
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold text-[var(--v2-ink)]">Offers</h2>
            <OffersTable offers={offers} agents={agents} />
          </section>
        </>
      )}

      <div>
        <Button variant="ghost" size="sm" onClick={() => setSubmitOpen(true)}>
          List your payable service
        </Button>
      </div>

      <CatalogSubmitModal
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
        onVerifiedPayable={() => void refetch()}
      />
    </div>
  )
}
