'use client'

import { useState } from 'react'
import { PageHeader } from '@/components/ui/PageHeader'
import { MerchantGrid } from '@/components/marketplace/MerchantGrid'
import CatalogSubmitModal from '@/components/CatalogSubmitModal'
import { useMerchants } from '@/hooks/useCatalog'

export default function MarketplacePage() {
  const { merchants, loading, error, refetch } = useMerchants()
  const [submitOpen, setSubmitOpen] = useState(false)

  return (
    <div className="max-w-5xl" data-testid="marketplace-page">
      <PageHeader
        title="Marketplace"
        subtitle="Merchants your agents can pay — verified prices, one instruction per offer."
      />

      <MerchantGrid
        merchants={merchants}
        loading={loading}
        error={error}
        onSubmit={() => setSubmitOpen(true)}
      />

      <CatalogSubmitModal
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
        onVerifiedPayable={() => void refetch()}
      />
    </div>
  )
}
