'use client'

import { useState } from 'react'
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

export default function MerchantPage() {
  const params = useParams<{ slug: string }>()
  const slug = params.slug
  const { merchant, offers, loading, error, notFound, refetch } = useMerchant(slug)
  const { agents } = useAgents()
  const [submitOpen, setSubmitOpen] = useState(false)

  if (loading) {
    return (
      <div className="max-w-5xl space-y-4">
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
        <div className="rounded-xl border border-danger/20 bg-[var(--v2-danger-soft)] px-4 py-3">
          <p className="text-sm font-medium text-[var(--v2-danger)]">Could not load this merchant</p>
          <p className="mt-1 text-sm text-[var(--v2-danger)]">{error}</p>
        </div>
      </div>
    )
  }

  if (!merchant) return null

  const comingSoon = merchant.listing_status === 'coming_soon'

  return (
    <div className="max-w-5xl space-y-6" data-testid="merchant-page">
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
