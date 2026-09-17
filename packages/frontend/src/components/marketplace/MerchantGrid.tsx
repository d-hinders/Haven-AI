'use client'

import { useMemo, useState } from 'react'
import { FilterPill } from '@/components/ui/FilterPill'
import { Checkbox } from '@/components/ui/Checkbox'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Skeleton } from '@/components/ui/Skeleton'
import { Button } from '@/components/ui/Button'
import { chainName, networkToChainId } from '@/lib/marketplace'
import { MerchantCard } from './MerchantCard'
import type { Merchant } from '@/hooks/useCatalog'

/** Sepolia's CAIP-2 id — the one testnet a live merchant is seeded on today (epic #3077 decision 11). */
const TESTNET_NETWORK = 'eip155:84532'

export function MerchantGrid({
  merchants,
  loading,
  error,
  onSubmit,
}: {
  merchants: Merchant[]
  loading: boolean
  error: string | null
  /** Opens the "list your payable service" modal (scope item 4). */
  onSubmit: () => void
}) {
  const [category, setCategory] = useState<string | null>(null)
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
  // read off the served data, never `NEXT_PUBLIC_HAVEN_ENV` (decision 10).
  const testMerchantsDefaultOn = useMemo(
    () => merchants.some((m) => m.networks.includes(TESTNET_NETWORK)),
    [merchants],
  )
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

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-40 rounded-xl" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-xl border border-danger/20 bg-[var(--v2-danger-soft)] px-4 py-3">
        <p className="text-sm font-medium text-[var(--v2-danger)]">Could not load the marketplace</p>
        <p className="mt-1 text-sm text-[var(--v2-danger)]">{error}</p>
      </div>
    )
  }

  const emptyMarketplace = merchants.length === 0

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
        <Checkbox
          label="Verified only"
          checked={verifiedOnly}
          onChange={(e) => setVerifiedOnly(e.target.checked)}
        />
        <Checkbox
          label="Show test merchants"
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
              <span className="capitalize">{c}</span>
            </FilterPill>
          ))}
        </div>
      )}

      {emptyMarketplace ? (
        <EmptyState
          title="No merchants listed yet"
          body="The marketplace is curated — new payable merchants appear here as they are verified."
        />
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-6 text-center">
          <p className="text-sm font-medium text-[var(--v2-ink-2)]">No merchants match this filter</p>
        </div>
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
