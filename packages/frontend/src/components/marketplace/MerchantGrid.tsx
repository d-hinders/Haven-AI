'use client'

import { useMemo, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { FilterPill } from '@/components/ui/FilterPill'
import { Checkbox } from '@/components/ui/Checkbox'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Skeleton } from '@/components/ui/Skeleton'
import { Button } from '@/components/ui/Button'
import { categoryLabel, chainName, listsTestnet, networkToChainId } from '@/lib/marketplace'
import { MerchantCard } from './MerchantCard'
import type { Merchant } from '@/hooks/useCatalog'

export function MerchantGrid({
  merchants,
  loading,
  error,
  onSubmit,
  onRetry,
  initialCategory = null,
}: {
  merchants: Merchant[]
  loading: boolean
  error: string | null
  /** Opens the "list your payable service" modal (scope item 4). */
  onSubmit: () => void
  /** Re-fetches after a failed load; the error state offers it as the way forward. */
  onRetry?: () => void
  /** A deep-linked category (`/catalog?category=ai` redirects here with its query intact). */
  initialCategory?: string | null
}) {
  const [category, setCategory] = useState<string | null>(initialCategory)
  const [search, setSearch] = useState('')
  const [verifiedOnly, setVerifiedOnly] = useState(false)
  const [chainFilter, setChainFilter] = useState<number | 'all'>('all')

  // The chains any listed merchant serves — the network dropdown only offers
  // a real choice when there is more than one (epic scope item 2).
  const chainIds = useMemo(
    () =>
      Array.from(
        new Set(
          merchants.flatMap((m) => m.networks.map((n) => networkToChainId(n))).filter(
            (id): id is number => id !== undefined,
          ),
        ),
      ).sort((a, b) => a - b),
    [merchants],
  )
  const showNetworkFilter = chainIds.length > 1

  // Default "Show test merchants" ON when any LISTED network is a testnet —
  // read off the served data (chain facts from core, not a hard-coded id),
  // never `NEXT_PUBLIC_HAVEN_ENV` (decision 10).
  const testMerchantsDefaultOn = useMemo(() => listsTestnet(merchants), [merchants])
  // The user's explicit choice, or none: the default is DERIVED at read time
  // from the served data, not captured into state at mount — the grid mounts
  // before the merchants arrive, and a `useState(default)` froze `false` on
  // the empty list (the baseline harness saw the demo store hidden with a
  // testnet listed). Toggling records a choice; until then the data decides.
  const [testMerchantsChoice, setTestMerchantsChoice] = useState<boolean | null>(null)
  const showTestMerchants = testMerchantsChoice ?? testMerchantsDefaultOn
  const setShowTestMerchants = setTestMerchantsChoice

  const categories = useMemo(
    () => Array.from(new Set(merchants.map((m) => m.category))).sort(),
    [merchants],
  )

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return merchants.filter((m) => {
      if (category && m.category !== category) return false
      if (verifiedOnly && !m.verified_payable) return false
      if (!showTestMerchants && m.is_test_merchant) return false
      if (chainFilter !== 'all' && !m.networks.some((n) => networkToChainId(n) === chainFilter)) {
        return false
      }
      if (q && !`${m.name} ${m.description}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [merchants, category, verifiedOnly, showTestMerchants, chainFilter, search])

  const filtered = category !== null || search.trim() !== '' || verifiedOnly || chainFilter !== 'all'
  const clearFilters = () => {
    setCategory(null)
    setSearch('')
    setVerifiedOnly(false)
    setChainFilter('all')
  }

  if (loading) {
    // The filter chrome's height is reserved so the cards do not jump when it
    // appears: search row, toggles/network row, category pills (measured on
    // the loaded page — the second row is the tall one, not the first).
    // `aria-busy` + `role="status"`: the skeletons are `aria-hidden`, so
    // without this the capture harness's content floor certified a
    // header-only page as finished; it refuses content still marked busy.
    return (
      <div role="status" aria-busy="true" aria-label="Loading merchants">
        <Skeleton className="mb-4 h-9 max-w-xs rounded-lg" />
        <Skeleton className="mb-4 h-9 w-80 rounded-lg" />
        <Skeleton className="mb-4 h-6 w-64 rounded-full" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <EmptyState
        icon={<Icon icon={AlertTriangle} className="h-5 w-5" />}
        tone="danger"
        title="Could not load the marketplace"
        body={error}
        action={
          onRetry ? (
            <Button variant="ghost" size="sm" onClick={onRetry}>
              Try again
            </Button>
          ) : undefined
        }
      />
    )
  }

  const emptyMarketplace = merchants.length === 0
  if (emptyMarketplace) {
    // No filter row over nothing: the one next step is the submit modal.
    return (
      <EmptyState
        title="No merchants listed yet"
        body="The marketplace is curated — new payable merchants appear here as they are verified."
        action={
          <Button variant="ghost" size="sm" onClick={onSubmit}>
            List your payable service
          </Button>
        }
      />
    )
  }

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search merchants"
          aria-label="Search merchants"
          className="max-w-xs"
        />
        <Button variant="ghost" size="sm" onClick={onSubmit}>
          List your payable service
        </Button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-4 text-xs font-medium text-[var(--v2-ink-2)]">
        {/* `min-h-11` below `sm`: the label IS the tap target, so a 44px row on a phone. */}
        <Checkbox
          label="Verified only"
          className="min-h-11 sm:min-h-0"
          checked={verifiedOnly}
          onChange={(e) => setVerifiedOnly(e.target.checked)}
        />
        <Checkbox
          label="Show test merchants"
          className="min-h-11 sm:min-h-0"
          checked={showTestMerchants}
          onChange={(e) => setShowTestMerchants(e.target.checked)}
        />
        {showNetworkFilter && (
          <div className="flex items-center gap-2">
            <label htmlFor="marketplace-network" className="text-xs font-medium text-[var(--v2-ink-3)]">
              Network
            </label>
            <Select
              id="marketplace-network"
              aria-label="Filter marketplace by network"
              value={chainFilter === 'all' ? 'all' : String(chainFilter)}
              onChange={(e) =>
                setChainFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))
              }
              className="max-w-[200px]"
            >
              <option value="all">All networks</option>
              {chainIds.map((id) => (
                <option key={id} value={String(id)}>
                  {chainName(id)}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>

      {categories.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter by category">
          <FilterPill active={category === null} onClick={() => setCategory(null)}>
            All
          </FilterPill>
          {categories.map((c) => (
            <FilterPill key={c} active={category === c} onClick={() => setCategory(c)}>
              {categoryLabel(c)}
            </FilterPill>
          ))}
        </div>
      )}

      {visible.length === 0 ? (
        <EmptyState
          size="compact"
          tone="neutral"
          title="No merchants match this filter"
          action={
            filtered ? (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {visible.map((merchant) => (
            <MerchantCard key={merchant.id} merchant={merchant} />
          ))}
        </div>
      )}
    </div>
  )
}
