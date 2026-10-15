'use client'

import { Suspense, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { PageHeader } from '@/components/ui/PageHeader'
import { MerchantGrid } from '@/components/marketplace/MerchantGrid'
import CatalogSubmitModal from '@/components/CatalogSubmitModal'
import { useMerchants } from '@/hooks/useCatalog'
import { useAuth } from '@/context/AuthContext'
import { resolveDefaultAccount } from '@/lib/default-account'

/**
 * The grid half of `/marketplace` (#3079, epic #3077). Rendered inside
 * `Suspense` because `useSearchParams` needs a boundary under static
 * rendering: the old `/catalog?category=ai` links redirect here with their
 * query intact (`next.config.ts`), and the grid honours it rather than
 * dropping the filter. The page header sits above the boundary so the
 * static shell paints something.
 */
function MarketplaceContent() {
  const { merchants, loading, error, refetch } = useMerchants()
  const [submitOpen, setSubmitOpen] = useState(false)
  const initialCategory = useSearchParams()?.get('category') ?? null
  // #3979: the grid's network filter starts on the user's own network.
  const { user } = useAuth()
  const defaultChainId = resolveDefaultAccount(user?.accounts)?.chain_id ?? null

  return (
    <>
      <MerchantGrid
        merchants={merchants}
        loading={loading}
        error={error}
        onSubmit={() => setSubmitOpen(true)}
        onRetry={() => void refetch()}
        initialCategory={initialCategory}
        defaultChainId={defaultChainId}
      />

      <CatalogSubmitModal
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
        onVerifiedPayable={() => void refetch()}
      />
    </>
  )
}

export default function MarketplacePage() {
  return (
    <div className="max-w-5xl" data-testid="marketplace-page">
      <PageHeader
        title="Marketplace"
        subtitle="Paid APIs and tools your agents can use. Copy an instruction and give it to your agent."
      />
      {/* The grid's own measured skeleton, so a capture between shell paint
          and boundary resolve is not an empty page that clears the content floor. */}
      <Suspense fallback={<MerchantGrid merchants={[]} loading error={null} onSubmit={() => {}} />}>
        <MarketplaceContent />
      </Suspense>
    </div>
  )
}
