'use client'

import { EmptyState } from '@/components/ui/EmptyState'

/**
 * The Setup tab (#4900 part 2 replaces this file): the receiving address, the
 * kit address and the slot where the Sales keys render (#4905). Part 1 reserves
 * the tab and its route state (`?tab=setup`) so the first-run steps can link to
 * it.
 */
export function SalesSetupTab() {
  return (
    <div className="mt-6" data-testid="sales-setup-tab">
      <EmptyState title="Setup" body="Your receiving address, kit address and Sales keys will show here." />
    </div>
  )
}

export default SalesSetupTab
