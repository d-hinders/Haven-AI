'use client'

import { useMemo, useState } from 'react'
import { AlertTriangle, Search } from 'lucide-react'
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

/** The fixture category (`088_merchants.ts`) — test content has its own checkbox, so no pill. */
const TEST_FIXTURE_CATEGORY = 'test-fixture'

export function MerchantGrid({
  merchants,
  loading,
  error,
  onSubmit,
  onRetry,
  initialCategory = null,
  defaultChainId = null,
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
  /**
   * The chain of the user's default account (#3979) — the network filter's
   * starting value when that chain is one the listed merchants serve. `null`
   * (no account, or still loading) starts on "All networks".
   */
  defaultChainId?: number | null
}) {
  // #3979: the test-fixture category has no pill — "Show test merchants" is
  // the one control for test content — so a deep link to it would be an
  // active filter nobody can see or clear. It opens as "All" instead.
  const [category, setCategory] = useState<string | null>(
    initialCategory === TEST_FIXTURE_CATEGORY ? null : initialCategory,
  )
  const [search, setSearch] = useState('')
  const [verifiedOnly, setVerifiedOnly] = useState(false)

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

  // #3979: the network filter starts on the user's own network. Derived at
  // read time like `showTestMerchants` below, never captured into state:
  // the merchants and the signed-in user both arrive after mount, and a
  // `useState(default)` would freeze "All networks" on the empty first render.
  // A choice — including "All networks" — overrides it from then on.
  const [chainChoice, setChainChoice] = useState<number | 'all' | null>(null)
  const defaultChainFilter: number | 'all' =
    showNetworkFilter && defaultChainId !== null && chainIds.includes(defaultChainId)
      ? defaultChainId
      : 'all'
  const chainFilter = chainChoice ?? defaultChainFilter

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
    () =>
      Array.from(new Set(merchants.map((m) => m.category)))
        .filter((c) => c !== TEST_FIXTURE_CATEGORY)
        .sort(),
    [merchants],
  )

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = merchants.filter((m) => {
      if (category && m.category !== category) return false
      if (verifiedOnly && !m.verified_payable) return false
      if (!showTestMerchants && m.is_test_merchant) return false
      // A merchant that lists no network — coming soon, or every offer
      // self-submitted (`Merchant.networks` counts operator offers only) —
      // cannot be placed on a network, so no network filter hides it.
      if (
        chainFilter !== 'all' &&
        m.networks.length > 0 &&
        !m.networks.some((n) => networkToChainId(n) === chainFilter)
      ) {
        return false
      }
      if (q && !`${m.name} ${m.description}`.toLowerCase().includes(q)) return false
      return true
    })
    // #3980: payable merchants first — `coming_soon` sorts before `live` in
    // `GET /merchants` (alphabetically), so the cards you cannot pay headed
    // the grid. The reorder is CLIENT-side on purpose: the endpoint's order
    // is read by other clients (agents among them) and this slice must not
    // change it. Within each group the served order survives: test merchants
    // last, then by name — the same keys the SQL's ORDER BY carries.
    return filtered.sort(
      (a, b) =>
        (a.listing_status === 'coming_soon' ? 1 : 0) - (b.listing_status === 'coming_soon' ? 1 : 0) ||
        (a.is_test_merchant ? 1 : 0) - (b.is_test_merchant ? 1 : 0) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    )
  }, [merchants, category, verifiedOnly, showTestMerchants, chainFilter, search])

  const filtered = category !== null || search.trim() !== '' || verifiedOnly || chainFilter !== 'all'
  const clearFilters = () => {
    setCategory(null)
    setSearch('')
    setVerifiedOnly(false)
    setChainChoice('all')
  }

  if (loading) {
    // The filter chrome's height is reserved so the cards do not jump when it
    // appears: the search/network row, then the pills/checkboxes row (#3979).
    // `aria-busy` + `role="status"`: the skeletons are `aria-hidden`, so
    // without this the capture harness's content floor certified a
    // header-only page as finished; it refuses content still marked busy.
    return (
      <div role="status" aria-busy="true" aria-label="Loading merchants">
        <Skeleton className="mb-3 h-9 w-full rounded-lg" />
        {/* #3979 deferred nit: the second row is two SHORT blocks (pills
            left, checkboxes right) on every width, not one long bar — a
            phone-width bar under-reserved the row it stands for. */}
        <div className="mb-4 flex items-center justify-between gap-x-4 gap-y-2">
          <Skeleton className="h-7 w-48 max-w-[45%] rounded-full" />
          <Skeleton className="h-7 w-36 max-w-[40%] rounded-full" />
        </div>
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
            List your service
          </Button>
        }
      />
    )
  }

  return (
    <div>
      {/* #3979: one toolbar row in the Contacts shape — a search field with a
          leading icon that fills the row, the network dropdown beside it. */}
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex-1">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search merchants"
            aria-label="Search merchants"
            leftIcon={<Icon icon={Search} className="h-4 w-4" />}
          />
        </div>
        {showNetworkFilter && (
          <Select
            aria-label="Filter marketplace by network"
            value={chainFilter === 'all' ? 'all' : String(chainFilter)}
            onChange={(e) => setChainChoice(e.target.value === 'all' ? 'all' : Number(e.target.value))}
            className="sm:max-w-[200px]"
          >
            <option value="all">All networks</option>
            {chainIds.map((id) => (
              <option key={id} value={String(id)}>
                {chainName(id)}
              </option>
            ))}
          </Select>
        )}
      </div>

      {/* Second row: what kind of merchant (pills) on the left, which ones
          (checkboxes) on the right; the checkboxes wrap beneath on a phone.
          #3979 deferred nit: the 44px tap boxes add their height below `sm`,
          so the row's bottom margin is trimmed there — the gap under the
          checkboxes no longer doubles the reserved space. */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 sm:mb-4">
        {categories.length > 1 ? (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by category">
            <FilterPill active={category === null} onClick={() => setCategory(null)}>
              All
            </FilterPill>
            {categories.map((c) => (
              <FilterPill key={c} active={category === c} onClick={() => setCategory(c)}>
                {categoryLabel(c)}
              </FilterPill>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-4 text-xs font-medium text-[var(--v2-ink-2)]">
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
        </div>
      </div>

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

      {/* #3979: listing a service is a seller's task, so it lives here with
          the context a seller needs rather than in the buyer's toolbar. */}
      <div
        className="mt-8 flex flex-col gap-3 border-t border-[var(--v2-border)] pt-5 sm:flex-row sm:items-center sm:justify-between"
        data-testid="marketplace-list-service"
      >
        <p className="text-sm text-[var(--v2-ink-3)]">
          <span className="font-medium text-[var(--v2-ink-2)]">Sell an API or MCP tool?</span> List it so Haven
          agents can pay for it — we check your endpoint before it appears here.
        </p>
        <Button variant="ghost" size="sm" onClick={onSubmit} className="shrink-0 self-start sm:self-auto">
          List your service
        </Button>
      </div>
    </div>
  )
}
