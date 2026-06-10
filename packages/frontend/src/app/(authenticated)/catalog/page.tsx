import CatalogPanel from '@/components/CatalogPanel'
import { PageHeader } from '@/components/ui/PageHeader'

export default function CatalogPage() {
  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Catalog"
        subtitle="Payable services your agents can discover and use — verified prices, one instruction to pay."
      />

      <CatalogPanel />
    </div>
  )
}
