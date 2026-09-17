'use client'

import { Suspense, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { PageHeader } from '@/components/ui/PageHeader'
import { MerchantGrid } from '@/components/marketplace/MerchantGrid'
import CatalogSubmitModal from '@/components/CatalogSubmitModal'
import { useMerchants } from '@/hooks/useCatalog'

/**
 * `/marketplace` (#3079, epic #3077). Rendered inside `Suspense` because
 * `useSearchParams` needs a boundary under static rendering: the old
 * `/catalog?category=ai` links redirect here with their query intact
 * (`next.config.ts`), and the grid honours it rather than dropping the filter.
 */
function MarketplaceContent() {
  const { merchants, loading, error, refetch } = useMerchants()
  const [submitOpen, setSubmitOpen] = useState(false)
  const initialCategory = useSearchParams()?.get('category') ?? null

  return (
    <div className="max-w-5xl" data-testid="marketplace-page">
      <PageHeader
        title="Marketplace"
        subtitle="Merchants your agents can pay — one instruction per offer."
      />

      <MerchantGrid
        merchants={merchants}
        loading={loading}
        error={error}
        onSubmit={() => setSubmitOpen(true)}
        onRetry={() => void refetch()}
        initialCategory={initialCategory}
      />

      <CatalogSubmitModal
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
        onVerifiedPayable={() => void refetch()}
      />
    </div>
  )
}

export default function MarketplacePage() {
  return (
    <Suspense fallback={null}>
      <MarketplaceContent />
    </Suspense>
  )
}
