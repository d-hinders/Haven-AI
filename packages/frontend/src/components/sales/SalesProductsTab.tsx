'use client'

import { EmptyState } from '@/components/ui/EmptyState'

/**
 * The Products tab (#4900 part 2 replaces this file): the catalogue display
 * from the kit deployment's products file. Part 1 reserves the tab and its
 * route state so the page's URL contract (`?tab=products`) is settled.
 */
export function SalesProductsTab() {
  return (
    <div className="mt-6" data-testid="sales-products-tab">
      <EmptyState title="Products" body="Your product list will show here." />
    </div>
  )
}

export default SalesProductsTab
