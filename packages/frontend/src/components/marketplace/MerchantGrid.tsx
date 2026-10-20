'use client'

import { useEffect, useMemo } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { Button } from '@/components/ui/Button'
import { ListNoMatch, ListToolbar } from '@/components/ui/ListToolbar'
import type { ListFacet } from '@/components/ui/FacetMenu'
import type { ListCount, ListNoun } from '@/components/ui/list-controls-copy'
import { clearedListState, sameValues, type ListState, type ListUrlSchema } from '@/components/ui/list-url-codec'
import { useListUrlState } from '@/components/ui/useListUrlState'
import { categoryLabel, chainName, listsTestnet, networkToChainId } from '@/lib/marketplace'
import { MerchantCard } from './MerchantCard'
import { ComingSoonMerchants } from './ComingSoonMerchants'
import type { Merchant } from '@/hooks/useCatalog'

/** The fixture category (`088_merchants.ts`) — test content has its own control, so no pill. */
const TEST_FIXTURE_CATEGORY = 'test-fixture'

const merchantNoun: ListNoun = { one: 'merchant', other: 'merchants' }

/**
 * The Verified and Test-merchant facets enumerate EVERY state as an option —
 * there is no separate "All" row (`allLabel: null`), because the initial
 * state is not All: it is the page default the codec holds ("no key means
 * the page's default"), and the rows read exactly "Any / Verified only" and
 * "Shown / Hidden" (#4114). The facet's `defaultValue` names that initial
 * state, so the trigger, the chip and Clear filters all agree with the URL.
 */
const VERIFIED_ANY = 'any'
const VERIFIED_ONLY = 'verified'
const TEST_SHOWN = 'shown'
const TEST_HIDDEN = 'hidden'

export function MerchantGrid({
  merchants,
  loading,
  error,
  onSubmit,
  onRetry,
  defaultChainId = null,
}: {
  merchants: Merchant[]
  loading: boolean
  error: string | null
  /** Opens the "list your payable service" modal (scope item 4). */
  onSubmit: () => void
  /** Re-fetches after a failed load; the error state offers it as the way forward. */
  onRetry?: () => void
  /**
   * The chain of the user's default account (#3979) — the network facet's
   * default when that chain is one the listed merchants serve AND there is
   * more than one listed chain. `null` (no account, or still loading) leaves
   * the default at All networks. The default stays OUT of the URL (no
   * `chainId` key) until the user picks something; an explicit
   * `chainId=all` means All networks and survives the default's arrival.
   */
  defaultChainId?: number | null
}) {
  // The chains any listed merchant serves — the network facet only offers a
  // real choice when there is more than one (epic scope item 2).
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
  // never `NEXT_PUBLIC_HAVEN_ENV` (decision 10). Derived, never captured:
  // the grid mounts before the merchants arrive.
  const testMerchantsDefaultOn = useMemo(() => listsTestnet(merchants), [merchants])

  // The URL-parse guard for `category` is built from ALL merchants' categories
  // (not the pill pool below): the parse must not consume a category whose
  // pill the network facet currently hides — #4008's reset below owns that
  // case. `test-fixture` is not a pill (#3979), so a deep link to it drops
  // on read and the grid opens as "All".
  const allCategories = useMemo(
    () => Array.from(new Set(merchants.map((m) => m.category))).filter((c) => c !== TEST_FIXTURE_CATEGORY),
    [merchants],
  )

  // #3979: the network filter starts on the user's own network. Derived into
  // the codec schema's `defaultValue`, so it updates when the user and the
  // merchants arrive — never captured into state, which would freeze
  // "All networks" on the empty first render.
  const networkDefault = useMemo(
    () =>
      showNetworkFilter && defaultChainId !== null && chainIds.includes(defaultChainId)
        ? [String(defaultChainId)]
        : [],
    [showNetworkFilter, defaultChainId, chainIds],
  )

  /**
   * The codec schema (#4114): every filter dimension lives in the URL. Its
   * identity must be stable across filter CHANGES (a re-parse would drop a
   * pending search commit), so it depends only on the data the defaults and
   * parse guards are read from — never on the current selection.
   */
  const schema = useMemo<ListUrlSchema>(
    () => ({
      search: {},
      facets: [
        // The key the old `?category=` deep links already used — the
        // `/catalog?category=ai` redirects keep working (#4114).
        { id: 'category', values: allCategories },
        { id: 'chainId', values: chainIds.map(String), defaultValue: networkDefault },
        { id: 'verified', values: [VERIFIED_ANY, VERIFIED_ONLY], defaultValue: [VERIFIED_ANY] },
        {
          id: 'test',
          values: [TEST_SHOWN, TEST_HIDDEN],
          defaultValue: [testMerchantsDefaultOn ? TEST_SHOWN : TEST_HIDDEN],
        },
      ],
    }),
    [allCategories, chainIds, networkDefault, testMerchantsDefaultOn],
  )

  const [listState, setListState] = useListUrlState(schema, { filtering: 'browser' })

  // The live filter values, read off the URL-backed state. An absent network
  // key IS the default (the codec filled it in); `all` arrives as an empty
  // selection.
  const chainChoice = listState.facets.chainId?.[0]
  const chainFilter: number | 'all' = chainChoice ? Number(chainChoice) : 'all'
  const testChoice = listState.facets.test?.[0]
  const showTestMerchants =
    testChoice === TEST_HIDDEN ? false : testChoice === TEST_SHOWN ? true : testMerchantsDefaultOn
  const verifiedOnly = listState.facets.verified?.[0] === VERIFIED_ONLY

  // #4008: the pill list is built from the merchants that pass the NETWORK
  // filter and the "Show test merchants" facet — but NOT the category,
  // search or verified filters — so pills never vanish while you are using
  // them. On dev, "Media" and "Search" matched only Base merchants, so under
  // the Base Sepolia default clicking one emptied the grid. A merchant that
  // lists no network survives any network filter (the rule `visible` applies
  // below), so its category counts too.
  const pillPool = useMemo(
    () =>
      merchants.filter((m) => {
        if (!showTestMerchants && m.is_test_merchant) return false
        if (
          chainFilter !== 'all' &&
          m.networks.length > 0 &&
          !m.networks.some((n) => networkToChainId(n) === chainFilter)
        ) {
          return false
        }
        return true
      }),
    [merchants, showTestMerchants, chainFilter],
  )

  const categories = useMemo(
    () =>
      Array.from(new Set(pillPool.map((m) => m.category)))
        .filter((c) => c !== TEST_FIXTURE_CATEGORY)
        .sort(),
    [pillPool],
  )

  // #4008: a selected category that no longer has a pill resets to "All",
  // derived at read time — the same rule #3979 applied to `test-fixture`
  // (`:45-47`): no filter is ever active without a visible pill. With the
  // URL as the state (#4114) the reset is WRITTEN, not just read: a facet
  // value the toolbar would raise a chip over must not sit in the state —
  // the chip is computed from it and would claim a filter that is not
  // applied. The old grid kept the raw choice in memory for a pill's
  // return; the codec cannot hold a value the toolbar does not show, so the
  // deep link is consumed instead (a fresh deep link re-selects).
  const rawCategory = listState.facets.category?.[0] ?? null
  const activeCategory = rawCategory !== null && categories.includes(rawCategory) ? rawCategory : null
  const categoryHasNoPill = rawCategory !== null && activeCategory === null
  useEffect(() => {
    if (!categoryHasNoPill) return
    setListState({ ...listState, facets: { ...listState.facets, category: [] } })
  }, [categoryHasNoPill, listState, setListState])

  const visible = useMemo(() => {
    const q = listState.q.trim().toLowerCase()
    const filtered = merchants.filter((m) => {
      if (activeCategory && m.category !== activeCategory) return false
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
    // The served order within each group: test merchants last, then by
    // name — the same keys the SQL's ORDER BY carries.
    return filtered.sort(
      (a, b) =>
        (a.is_test_merchant ? 1 : 0) - (b.is_test_merchant ? 1 : 0) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    )
  }, [merchants, activeCategory, verifiedOnly, showTestMerchants, chainFilter, listState.q])

  // #3980 sorted payable merchants first — `coming_soon` sorts before `live`
  // in `GET /merchants` (alphabetically), so the cards you cannot pay headed
  // the grid. #4052 goes one step further and splits them: payable merchants
  // fill the card grid, coming-soon ones list in their own section below it.
  // CLIENT-side on purpose: the endpoint's order is read by other clients
  // (agents among them) and must not change.
  const payable = visible.filter((m) => m.listing_status !== 'coming_soon')
  const comingSoon = visible.filter((m) => m.listing_status === 'coming_soon')

  // The facets the toolbar renders. Same ids, values and defaults as the
  // codec schema (one source of truth for chips and Clear filters), plus the
  // rendering data. Options are memoised on the pill pool, NOT on the
  // selection, so the objects stay stable while the user filters (#4008).
  const facets = useMemo<ListFacet[]>(
    () => [
      {
        id: 'category',
        label: 'Category',
        rendering: 'pills',
        values: allCategories,
        options: categories.map((c) => ({ value: c, label: categoryLabel(c) })),
      },
      {
        id: 'chainId',
        label: 'Network',
        values: chainIds.map(String),
        defaultValue: networkDefault,
        options: chainIds.map((id) => ({ value: String(id), label: chainName(id) })),
      },
      {
        id: 'verified',
        label: 'Verified',
        allLabel: null,
        values: [VERIFIED_ANY, VERIFIED_ONLY],
        defaultValue: [VERIFIED_ANY],
        options: [
          { value: VERIFIED_ANY, label: 'Any' },
          { value: VERIFIED_ONLY, label: 'Verified only' },
        ],
      },
      {
        id: 'test',
        label: 'Test merchants',
        allLabel: null,
        values: [TEST_SHOWN, TEST_HIDDEN],
        defaultValue: [testMerchantsDefaultOn ? TEST_SHOWN : TEST_HIDDEN],
        options: [
          { value: TEST_SHOWN, label: 'Shown' },
          { value: TEST_HIDDEN, label: 'Hidden' },
        ],
      },
    ],
    [categories, allCategories, chainIds, networkDefault, testMerchantsDefaultOn],
  )

  // "Filtered" is the toolbar's own rule — differs from the page default —
  // so the count cannot disagree with the chips.
  const filtered =
    listState.q.trim() !== '' ||
    facets.some((f) => !sameValues(listState.facets[f.id] ?? [], f.defaultValue ?? []))

  // The standard count (#4110). At the defaults the label reads the rendered
  // set ("50 merchants"); filtered, "{shown} of {total}" against every
  // listed merchant — a figure the shown set can never exceed.
  const count: ListCount = filtered
    ? { shown: visible.length, total: merchants.length }
    : { shown: visible.length, total: visible.length }

  if (loading) {
    // The filter chrome's height is reserved so the cards do not jump when it
    // appears: the ListToolbar card (#4114) stands where the old two-row
    // chrome did. `aria-busy` + `role="status"`: the skeletons are
    // `aria-hidden`, so without this the capture harness's content floor
    // certified a header-only page as finished; it refuses content still
    // marked busy.
    return (
      <div role="status" aria-busy="true" aria-label="Loading merchants">
        <Skeleton className="mb-4 h-[150px] w-full rounded-[10px]" />
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
    // No toolbar over nothing: the one next step is the submit modal.
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
      {/* #4114: the list-controls toolbar. Browser filtering — the merchant
          list is small, unpaged and has no export. The search commits per
          keystroke; only its URL write waits for a pause. */}
      <ListToolbar
        noun={merchantNoun}
        state={listState}
        onChange={setListState}
        filtering="browser"
        facets={facets}
        searchDescription="by name or description"
        count={count}
      />

      {visible.length === 0 ? (
        // The standard no-match state (#4110): it sits where the rows were —
        // in place of the grid, not inside it — and leaves the toolbar up, so
        // the cause stays editable. It covers BOTH groups (#4052): the
        // section and the cards go together.
        <div className="mt-3" data-testid="marketplace-no-match">
          <ListNoMatch
            noun={merchantNoun}
            onClear={() => setListState(clearedListState(listState, schema))}
          />
        </div>
      ) : (
        // #4052: either group may be empty on its own (a search for one
        // coming-soon merchant leaves no cards); the empty state above is
        // for when BOTH are.
        <div className="flex flex-col gap-6">
          {payable.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {payable.map((merchant) => (
                <MerchantCard key={merchant.id} merchant={merchant} />
              ))}
            </div>
          )}
          <ComingSoonMerchants merchants={comingSoon} />
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
