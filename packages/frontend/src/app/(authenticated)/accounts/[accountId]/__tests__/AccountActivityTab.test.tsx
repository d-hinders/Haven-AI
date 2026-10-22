/**
 * #4098/#4130 — the account page's Activity tab: filters seeded from and
 * written to the URL next to the page's `tab` through the list-controls
 * codec, the standard `ListToolbar` (with the Account facet absent — the
 * page fixes the account), the standard count and no-match copy, paging
 * through "Show N more" below the card (#4196), the row-to-panel open by mouse and keyboard, the
 * truncated-history honesty, and the CSV export carrying the fixed account
 * plus the active filters.
 *
 * The behaviours `filterbar-search-period.test.tsx` pinned against
 * `FilterBar` are retargeted here onto the toolbar the tab now renders:
 * the debounced/Enter search commit, a cleared chip cancelling a pending
 * debounce, the five Period options, and the reversed custom range refusal.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

const {
  mockGet,
  mockGetText,
  mockDownloadCsv,
  feedMock,
  totalsMock,
  filtersMock,
  urlQuery,
  seenFilters,
} = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockGetText: vi.fn(),
  mockDownloadCsv: vi.fn(),
  feedMock: vi.fn(),
  totalsMock: vi.fn(),
  filtersMock: vi.fn(),
  urlQuery: { value: '' },
  seenFilters: { value: null as Record<string, unknown> | null },
}))

vi.mock('next/navigation', () => ({
  // The codec's URL writes go through `useListUrlState`, which needs the
  // page path; the tab itself no longer touches the router.
  usePathname: () => '/accounts/safe-1',
  // The tab seeds its filters from the URL once, at mount — the query a
  // shared link carries.
  useSearchParams: () => new URLSearchParams(urlQuery.value),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: {
      ...actual.api,
      get: (...a: unknown[]) => mockGet(...a),
      getText: (...a: unknown[]) => mockGetText(...a),
    },
  }
})

vi.mock('@/lib/transaction-csv', async () => {
  const actual = await vi.importActual<typeof import('@/lib/transaction-csv')>('@/lib/transaction-csv')
  return { ...actual, downloadCsv: (...a: unknown[]) => mockDownloadCsv(...a) }
})

vi.mock('@/hooks/useTransactionsFeed', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useTransactionsFeed')>(
    '@/hooks/useTransactionsFeed',
  )
  return {
    ...actual,
    useTransactionsFeed: (filters: unknown, limit: number) => {
      // What the tab handed the feed: the URL-seeded filters plus the fixed
      // account — the contract that makes the rows, the count and the
      // export describe one set.
      seenFilters.value = filters as Record<string, unknown>
      return feedMock(filters, limit)
    },
  }
})

vi.mock('@/hooks/useActivityMoneyTotals', () => ({
  useActivityMoneyTotals: (filters: unknown, currency: unknown) => totalsMock(filters, currency),
}))

vi.mock('@/hooks/useTransactionFilters', () => ({
  useTransactionFilters: (...args: unknown[]) => filtersMock(...args),
}))

vi.mock('@/components/transactions/TransactionDetailPanel', () => ({
  // The panel is covered by its own tests; here it only has to say whether
  // the tab opened it, and with which row.
  default: ({
    open,
    transaction,
  }: {
    open: boolean
    transaction: { hash: string } | null
  }): ReactNode =>
    open ? <div data-testid="detail-panel">panel:{transaction?.hash}</div> : null,
}))

import AccountActivityTab from '../AccountActivityTab'
import type { AggregatedTransaction, TransactionFilterTokenOption } from '@/types/transactions'

function tx(overrides: Partial<AggregatedTransaction>): AggregatedTransaction {
  return {
    hash: '0xabc',
    type: 'erc20',
    from: '0x' + 'bb'.repeat(20),
    to: '0x' + 'cc'.repeat(20),
    value: '1000000',
    valueFormatted: '1.00',
    asset: 'USDC',
    tokenSymbol: 'USDC',
    decimals: 6,
    direction: 'in',
    timestamp: 1_778_240_999,
    blockNumber: 1,
    isError: false,
    chainId: 8453,
    accountId: 'safe-1',
    accountAddress: '0x' + 'aa'.repeat(20),
    accountName: 'Main',
    convertedAmount: '10.00',
    convertedCurrency: 'USD',
    ...overrides,
  } as AggregatedTransaction
}

const DEFAULT_FEED = {
  transactions: [tx({}), tx({ hash: '0xdef', direction: 'out' })],
  total: 2,
  loadingInitial: false,
  loadingMore: false,
  hasMore: false,
  error: null,
  partialFailure: false,
  failedAccountIds: [],
  truncated: false,
  loadMore: vi.fn(),
  refresh: vi.fn(),
}

const DEFAULT_TOTALS = {
  moneyIn: 10 as number | null,
  moneyOut: 4 as number | null,
  approxIn: false,
  approxOut: false,
  unpriced: false,
  loading: false,
  error: null,
  partial: false,
  refresh: vi.fn(),
}

const DEFAULT_FILTERS = {
  accounts: [{ id: 'safe-1', name: 'Main', chainId: 8453, address: '0x' + 'aa'.repeat(20) }],
  agents: [],
  tokens: [] as TransactionFilterTokenOption[],
  loading: false,
  error: null,
}

function renderTab(overrides: Record<string, unknown> = {}) {
  return render(
    <AccountActivityTab
      accountId="safe-1"
      chainId={8453}
      currency="USD"
      resolveAddress={() => null}
      accountNamesByAddress={new Map()}
      onReceive={vi.fn()}
      {...overrides}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  urlQuery.value = ''
  mockGet.mockResolvedValue({ total: 2 })
  feedMock.mockImplementation(() => ({ ...DEFAULT_FEED, loadMore: vi.fn(), refresh: vi.fn() }))
  totalsMock.mockImplementation(() => ({ ...DEFAULT_TOTALS, refresh: vi.fn() }))
  filtersMock.mockImplementation(() => ({ ...DEFAULT_FILTERS }))
})

/** Flush the toolbar's 300 ms server-search debounce. */
function flushSearchCommit() {
  return act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
}

/** The ledger's whole-row buttons (#4096's ledger mode). */
function ledgerRows(): HTMLElement[] {
  return screen
    .getAllByRole('button')
    .filter(
      (element) =>
        element.getAttribute('aria-haspopup') === 'dialog' &&
        element.closest('[data-testid="list-toolbar"]') === null,
    )
}

describe('AccountActivityTab — filters in the URL (#4098/#4130)', () => {
  it('seeds the filters from the URL and sends them to the feed with the fixed account', () => {
    urlQuery.value = 'search=coffee&direction=in'
    renderTab()

    expect(seenFilters.value).toMatchObject({ search: 'coffee', direction: 'in', accountId: 'safe-1' })
    // The per-account ledger keeps both legs of a move: it never asks for
    // the all-accounts fold `/transactions` requests (#4266).
    expect(seenFilters.value).not.toHaveProperty('foldOwnTransfers')
    // The toolbar echoes the seeded search as a removable chip; the Account
    // facet does not exist here — the page fixes the account.
    expect(screen.getByRole('button', { name: 'Remove “coffee”' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Account:/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove Account: Main' })).not.toBeInTheDocument()
  })

  it('drops a stray accountId from the URL — the page fixes the account', () => {
    window.history.replaceState(null, '', '/accounts/safe-1?accountId=other-account&search=coffee')
    urlQuery.value = 'accountId=other-account&search=coffee'
    renderTab()

    expect(seenFilters.value).toMatchObject({ search: 'coffee', accountId: 'safe-1' })
    // Repaired once, on arrival: the inert parameter never pins the URL.
    expect(window.location.search).toBe('?search=coffee')
    window.history.replaceState(null, '', '/accounts/safe-1')
  })

  it('writes the URL through the codec, next to the page tab', async () => {
    vi.useFakeTimers()
    // The codec serialises against the address bar, so the tab must be in
    // window.location for the write to carry it — as it is in the browser.
    window.history.replaceState(null, '', '/accounts/safe-1?tab=activity')
    urlQuery.value = 'tab=activity'
    renderTab()

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search transactions' }), {
      target: { value: 'coffee' },
    })
    await flushSearchCommit()

    // `q` is the codec's search key; the page's own `tab` rides along
    // untouched — the codec only sets or deletes keys it owns.
    expect(window.location.search).toBe('?tab=activity&q=coffee')
    window.history.replaceState(null, '', '/accounts/safe-1')
    vi.useRealTimers()
  })

  it('clears every filter back to the bare account URL, tab included', async () => {
    vi.useFakeTimers()
    window.history.replaceState(null, '', '/accounts/safe-1?tab=activity&q=coffee&direction=in')
    urlQuery.value = 'tab=activity&q=coffee&direction=in'
    renderTab()

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(window.location.search).toBe('?tab=activity')
    window.history.replaceState(null, '', '/accounts/safe-1')
    vi.useRealTimers()
  })
})

describe('AccountActivityTab — the toolbar search (#4130, retargeted from FilterBar #4095)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('commits debounced — the feed sees one search per pause, not per keystroke', async () => {
    renderTab()
    const field = screen.getByRole('searchbox', { name: 'Search transactions' })

    fireEvent.change(field, { target: { value: 's' } })
    fireEvent.change(field, { target: { value: 'sa' } })
    fireEvent.change(field, { target: { value: 'sav' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299)
    })
    expect(seenFilters.value).toMatchObject({ search: undefined })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(seenFilters.value).toMatchObject({ search: 'sav' })
  })

  it('commits immediately on Enter', () => {
    renderTab()

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search transactions' }), {
      target: { value: 'cafe' },
    })
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search transactions' }), { key: 'Enter' })

    expect(seenFilters.value).toMatchObject({ search: 'cafe' })
  })

  it('a cleared chip resets the field and cancels a pending debounce', async () => {
    // The stale-debounce hazard the FilterBar suite pinned: type a new term
    // (timer pending), then clear via the chip — the external reset must
    // cancel the timer, or it would fire afterwards and re-add the term the
    // user just removed.
    urlQuery.value = 'q=old'
    renderTab()

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search transactions' }), {
      target: { value: 'new' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Remove “old”' }))

    expect(seenFilters.value).toMatchObject({ search: undefined })
    expect(screen.getByRole('searchbox', { name: 'Search transactions' })).toHaveValue('')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    // The cancelled debounce did not resurrect the term.
    expect(seenFilters.value).toMatchObject({ search: undefined })
    expect(screen.getByRole('searchbox', { name: 'Search transactions' })).toHaveValue('')
  })
})

describe('AccountActivityTab — the Period picker (#4130, retargeted from FilterBar #4095)', () => {
  it('offers the five options: All time, three rolling presets, Custom range', () => {
    renderTab()

    fireEvent.click(screen.getByRole('button', { name: 'Period: All time' }))

    const menu = screen.getByRole('menu')
    expect(within(menu).getByRole('menuitemradio', { name: 'All time' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitemradio', { name: 'Last 7 days' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitemradio', { name: 'Last 30 days' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitemradio', { name: 'Last 90 days' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitemradio', { name: 'Custom range' })).toBeInTheDocument()
  })

  it('a preset lands as a removable chip and clears back to All time', () => {
    renderTab()

    fireEvent.click(screen.getByRole('button', { name: 'Period: All time' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Last 7 days' }))

    // Active preset: the chip is the way back out, and the feed narrows.
    fireEvent.click(screen.getByRole('button', { name: 'Remove Period: Last 7 days' }))
    expect(seenFilters.value).toMatchObject({ period: undefined, from: undefined, to: undefined })
    expect(screen.queryByRole('button', { name: 'Remove Period: Last 7 days' })).not.toBeInTheDocument()
  })

  it('a custom range applies two calendar dates, refused while reversed', () => {
    renderTab()

    fireEvent.click(screen.getByRole('button', { name: 'Period: All time' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Custom range' }))

    const from = screen.getByLabelText('From')
    const to = screen.getByLabelText('To')
    const apply = screen.getByRole('button', { name: 'Apply' })

    // Reversed range: refused here, before the server can 400 it.
    fireEvent.change(from, { target: { value: '2026-05-09' } })
    fireEvent.change(to, { target: { value: '2026-05-08' } })
    expect(apply).toBeDisabled()

    fireEvent.change(from, { target: { value: '2026-05-08' } })
    fireEvent.change(to, { target: { value: '2026-05-09' } })
    expect(apply).toBeEnabled()
    fireEvent.click(apply)

    expect(seenFilters.value).toMatchObject({ period: undefined, from: '2026-05-08', to: '2026-05-09' })
  })
})

describe('AccountActivityTab — result count (#4130)', () => {
  it('says the server count for the unfiltered ledger', () => {
    renderTab()

    expect(within(screen.getByTestId('list-summary')).getByTestId('list-toolbar-count')).toHaveTextContent('2 transactions')
  })

  it('says "{shown} of {total}" against the ACCOUNT total when a filter narrows the set', async () => {
    urlQuery.value = 'q=coffee'
    mockGet.mockResolvedValue({ total: 5 })
    feedMock.mockImplementation(() => ({
      ...DEFAULT_FEED,
      total: 3,
      hasMore: true,
      loadMore: vi.fn(),
      refresh: vi.fn(),
    }))
    renderTab()

    // The denominator read is scoped to the fixed account — an unscooped
    // read would count every account's transactions.
    await waitFor(() =>
      expect(mockGet).toHaveBeenCalledWith('/transactions?offset=0&limit=1&accountId=safe-1'),
    )
    await waitFor(() =>
      expect(within(screen.getByTestId('list-summary')).getByTestId('list-toolbar-count')).toHaveTextContent('3 of 5 transactions'),
    )
    expect(document.body.textContent).not.toContain('matching')
  })

  it('shows no count figure rather than one it cannot back, and qualifies a capped feed', () => {
    urlQuery.value = 'q=coffee'
    mockGet.mockResolvedValue({ partialFailure: true })
    feedMock.mockImplementation(() => ({
      ...DEFAULT_FEED,
      total: 3,
      hasMore: true,
      truncated: true,
      loadMore: vi.fn(),
      refresh: vi.fn(),
    }))
    renderTab()

    // Unknown denominator: no figure rather than "3 of ?" or "3 of 25".
    expect(screen.queryByText(/transactions/)).toBeNull()
    expect(
      screen.getByText(/may not be your full history/i),
    ).toBeInTheDocument()
  })
})

describe('AccountActivityTab — empty states (#4098/#4130)', () => {
  it('shows "No activity yet" with a Receive button for an account with no history', () => {
    const onReceive = vi.fn()
    feedMock.mockImplementation(() => ({
      ...DEFAULT_FEED,
      transactions: [],
      total: 0,
      loadMore: vi.fn(),
      refresh: vi.fn(),
    }))
    renderTab({ onReceive })

    expect(screen.getByText('No activity yet')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Receive' }))
    expect(onReceive).toHaveBeenCalledTimes(1)
  })

  it('shows the standard no-match state when a filter matches nothing', () => {
    urlQuery.value = 'q=coffee'
    feedMock.mockImplementation(() => ({
      ...DEFAULT_FEED,
      transactions: [],
      total: 0,
      loadMore: vi.fn(),
      refresh: vi.fn(),
    }))
    renderTab()

    expect(screen.getByText('No transactions match these filters')).toBeInTheDocument()
    expect(screen.getByText('Try a different search, or clear filters to see everything.')).toBeInTheDocument()
    expect(screen.queryByText('No activity yet')).not.toBeInTheDocument()
    // Two Clear filters are on screen — the toolbar's and the no-match
    // state's own — and both reach the same handler.
    fireEvent.click(
      within(screen.getByTestId('activity-no-match')).getByRole('button', { name: 'Clear filters' }),
    )
    expect(window.location.search).toBe('')
  })
})

describe('AccountActivityTab — rows and the detail panel (#4098)', () => {
  it('opens the detail panel by mouse and by keyboard', () => {
    renderTab()

    // #4096's ledger mode: every row is a whole-row button (aria-haspopup
    // dialog). The toolbar's phone "Filters" button carries the same
    // attribute, so ledgerRows() excludes anything inside the toolbar.
    // Mouse first…
    const rows = ledgerRows()
    expect(rows.length).toBe(2)
    fireEvent.click(rows[0])
    expect(screen.getByTestId('detail-panel')).toHaveTextContent('panel:0xabc')

    // …then keyboard: Enter activates the second row the way the row's
    // button role promises.
    fireEvent.keyDown(rows[1], { key: 'Enter' })
    expect(screen.getByTestId('detail-panel')).toHaveTextContent('panel:0xdef')

    // And Space activates too — the second keyboard affordance of the role.
    fireEvent.keyDown(rows[1], { key: ' ' })
    expect(screen.getByTestId('detail-panel')).toHaveTextContent('panel:0xdef')
  })

  it('pages with "Show N more" below the list card, N being what the next page adds (#4196)', () => {
    const loadMore = vi.fn()
    feedMock.mockImplementation(() => ({
      ...DEFAULT_FEED,
      total: 5,
      hasMore: true,
      loadMore,
      refresh: vi.fn(),
    }))
    renderTab()

    // 2 loaded of 5: the next page adds 3.
    const button = screen.getByRole('button', { name: 'Show 3 more' })
    // Outside the card: the card ends with its last row.
    const card = ledgerRows()[0].closest('.shadow-card')
    expect(card).not.toBeNull()
    expect(card).not.toContainElement(button)
    fireEvent.click(button)
    expect(loadMore).toHaveBeenCalledTimes(1)
  })

  it('reads "Loading…" while the next page fetches, and renders nothing once every page is loaded (#4196)', () => {
    feedMock.mockImplementation(() => ({ ...DEFAULT_FEED, total: 5, hasMore: true, loadingMore: true, loadMore: vi.fn(), refresh: vi.fn() }))
    const { unmount } = renderTab()
    expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled()
    unmount()

    feedMock.mockImplementation(() => ({ ...DEFAULT_FEED, total: 2, hasMore: false, loadMore: vi.fn(), refresh: vi.fn() }))
    renderTab()
    expect(screen.queryByTestId('list-show-more')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Show .*more$/ })).not.toBeInTheDocument()
  })

  it('shows the server-side in/out totals for the filtered set', () => {
    renderTab()

    expect(screen.getByText(/Money in/)).toBeInTheDocument()
    expect(screen.getByText(/Money out/)).toBeInTheDocument()
  })

  it('draws the totals on the left of the list summary line, the count on the right (#4196)', () => {
    renderTab()

    const line = screen.getByTestId('list-summary')
    // Visible "In · Out" so the line fits a phone; each figure keeps its full
    // name for screen readers, read before the amount (#4108, after #4196).
    const [moneyIn, moneyOut] = within(line).getAllByTestId('activity-total')
    expect(within(moneyIn).getByText('In')).toHaveAttribute('aria-hidden', 'true')
    expect(within(moneyIn).getByText('Money in')).toHaveClass('sr-only')
    expect(within(moneyOut).getByText('Out')).toHaveAttribute('aria-hidden', 'true')
    expect(within(moneyOut).getByText('Money out')).toHaveClass('sr-only')
    // The sr-only name comes before the figure it names.
    expect(moneyIn.textContent).toMatch(/^InMoney in \$/)
    expect(line.firstElementChild).toContainElement(within(line).getByTestId('activity-totals'))
    expect(line.lastElementChild).toBe(screen.getByTestId('list-toolbar-count'))
    expect(within(screen.getByTestId('list-summary')).getByTestId('list-toolbar-count')).toHaveTextContent('2 transactions')
    // Unfiltered: the toolbar draws no status row.
    expect(screen.queryByTestId('list-toolbar-status')).not.toBeInTheDocument()
  })

  it('says in words when some rows could not be valued, and shows "—" for an unknown total (#4165)', () => {
    totalsMock.mockImplementation(() => ({ ...DEFAULT_TOTALS, moneyOut: null, unpriced: true, refresh: vi.fn() }))
    renderTab()

    expect(screen.getByText('Some amounts couldn’t be valued and aren’t included.')).toBeInTheDocument()
    const moneyOut = screen.getAllByTestId('activity-total')[1]
    expect(moneyOut).toHaveTextContent('OutMoney out —')
    expect(screen.queryByText(/\u2248/)).not.toBeInTheDocument()
  })

  it('rows never carry "≈", even a serve-time SEK row (#3950, #4165)', () => {
    feedMock.mockImplementation(() => ({
      ...DEFAULT_FEED,
      transactions: [tx({ convertedAmount: null, approxAmount: '134.50', approxCurrency: 'SEK' })],
      total: 1,
      loadMore: vi.fn(),
      refresh: vi.fn(),
    }))
    renderTab({ currency: 'SEK' })

    expect(ledgerRows()[0]).not.toHaveTextContent('\u2248')
  })

  it('separates same-day rows with an inset hairline; the first row of a day has none (#4165)', () => {
    renderTab()

    const rows = ledgerRows()
    // DEFAULT_FEED's two rows share one timestamp, so one day group.
    expect(rows[0]).not.toHaveAttribute('data-inset-divider')
    expect(rows[1]).toHaveAttribute('data-inset-divider')
  })

  it('hides the totals while they load — no figure beats a wrong one', () => {
    totalsMock.mockImplementation(() => ({ ...DEFAULT_TOTALS, loading: true, refresh: vi.fn() }))
    renderTab()

    expect(screen.queryByText(/Money in/)).not.toBeInTheDocument()
  })
})

describe('AccountActivityTab — the facet set (#4130)', () => {
  it('names a token on an unknown chain generically in the Token facet', () => {
    filtersMock.mockImplementation(() => ({
      ...DEFAULT_FILTERS,
      // Two options: a facet with a single possible value hides itself, so
      // the label needs a second token on the account's own chain to render.
      tokens: [
        { key: 't', symbol: 'FOO', chainId: 999999, isNative: false } as never,
        { key: 'n', symbol: 'ETH', chainId: 8453, isNative: true } as never,
      ],
    }))
    renderTab()

    fireEvent.click(screen.getByRole('button', { name: 'Token: All' }))
    expect(screen.getByRole('menuitemradio', { name: 'FOO (Chain 999999)' })).toBeInTheDocument()
  })

  it('names a chain-100 token with the Gnosis name in the Token facet', () => {
    filtersMock.mockImplementation(() => ({
      ...DEFAULT_FILTERS,
      tokens: [
        { key: 't', symbol: 'USDC.e', chainId: 100, isNative: false } as never,
        { key: 'n', symbol: 'ETH', chainId: 8453, isNative: true } as never,
      ],
    }))
    renderTab()

    fireEvent.click(screen.getByRole('button', { name: 'Token: All' }))
    expect(screen.getByRole('menuitemradio', { name: 'USDC.e (Gnosis)' })).toBeInTheDocument()
  })

  it('hides the Network facet — the account lives on one chain, there is nothing to choose', () => {
    renderTab()

    expect(screen.queryByRole('button', { name: /^Network:/ })).not.toBeInTheDocument()
  })

  it('#4166: the row leads with who was paid and carries the agent as the subtitle — no "Agent payment by", no movement line', () => {
    feedMock.mockImplementation(() => ({
      ...DEFAULT_FEED,
      transactions: [
        tx({
          hash: '0x01',
          direction: 'out',
          source: 'x402',
          x402ResourceUrl: 'https://research.example/report',
          agentName: 'Research agent',
        }),
      ],
      total: 1,
    }))
    renderTab()
    const row = ledgerRows()[0]
    // Merchant first, as on the dashboard — the shared `transactionTitle`
    // ("Agent payment by …") is untouched, this row just doesn't use it.
    expect(row).toHaveTextContent('research.example')
    expect(row).not.toHaveTextContent('Agent payment by')
    // The agent is the subtitle; the movement line is gone — the page fixes
    // the account, so "From Main account →" repeated the page on every row.
    expect(row).toHaveTextContent('Research agent')
    expect(row).not.toHaveTextContent(/From Main/)
    expect(row).not.toHaveTextContent(/→/)
  })

  it('#4099: names a transfer between own accounts on both sides, with no "From <this account>" segment', () => {
    const main = '0x' + 'aa'.repeat(20)
    const reserve = '0x' + 'dd'.repeat(20)
    const ownAccounts = new Map([
      [`${main}:8453`, 'Main'],
      [`${reserve}:8453`, 'Reserve'],
    ])
    const transfer = { from: main, to: reserve }

    // Sending side: Main's ledger — the title is who was paid (Reserve).
    feedMock.mockImplementation(() => ({
      ...DEFAULT_FEED,
      transactions: [tx({ ...transfer, hash: '0x01', direction: 'out', initiatedBy: 'human' })],
      total: 1,
    }))
    const { unmount } = renderTab({ accountNamesByAddress: ownAccounts })
    let row = ledgerRows()[0]
    expect(row).toHaveTextContent('Reserve')
    expect(row).not.toHaveTextContent('Payment sent by you')
    expect(row).not.toHaveTextContent(/From Main/)
    expect(row).not.toHaveTextContent('New recipient')
    unmount()

    // Receiving side: Reserve's ledger, the same transfer inbound — the
    // counterparty-first title names the sending account.
    feedMock.mockImplementation(() => ({
      ...DEFAULT_FEED,
      transactions: [
        tx({
          ...transfer,
          hash: '0x01',
          direction: 'in',
          accountId: 'safe-2',
          accountAddress: reserve,
          accountName: 'Reserve',
        }),
      ],
      total: 1,
    }))
    renderTab({ accountId: 'safe-2', accountNamesByAddress: ownAccounts })
    row = ledgerRows()[0]
    expect(row).toHaveTextContent('From Main')
    expect(row).not.toHaveTextContent('Deposit')
    expect(row).not.toHaveTextContent(/→/)
  })
})

describe('AccountActivityTab — CSV export (#4098)', () => {
  it('carries the fixed account and the active filters on the export request', async () => {
    urlQuery.value = 'q=coffee'
    mockGetText.mockResolvedValue('﻿hash\r\n"0xabc"')
    renderTab()

    fireEvent.click(screen.getByRole('button', { name: /export csv/i }))
    await waitFor(() => expect(mockDownloadCsv).toHaveBeenCalledTimes(1))
    expect(mockGetText).toHaveBeenCalledWith(
      expect.stringContaining('/transactions/export.csv?'),
    )
    expect(mockGetText).toHaveBeenCalledWith(expect.stringContaining('accountId=safe-1'))
    // The API's own spelling: the URL writes `q`, the backend reads `search`.
    expect(mockGetText).toHaveBeenCalledWith(expect.stringContaining('search=coffee'))
  })

  it('stays disabled while the server says there is nothing to export', () => {
    feedMock.mockImplementation(() => ({
      ...DEFAULT_FEED,
      transactions: [],
      total: 0,
      loadMore: vi.fn(),
      refresh: vi.fn(),
    }))
    renderTab()

    expect(screen.getByRole('button', { name: /export csv/i })).toBeDisabled()
  })
})

describe('AccountActivityTab — refresh after a send (#4098)', () => {
  it('re-reads the ledger and its totals when the page bumps the refresh key', () => {
    const feedRefresh = vi.fn()
    const totalsRefresh = vi.fn()
    feedMock.mockImplementation(() => ({ ...DEFAULT_FEED, refresh: feedRefresh }))
    totalsMock.mockImplementation(() => ({ ...DEFAULT_TOTALS, refresh: totalsRefresh }))

    const view = renderTab()
    expect(feedRefresh).not.toHaveBeenCalled()

    view.rerender(
      <AccountActivityTab
        accountId="safe-1"
        chainId={8453}
        currency="USD"
        resolveAddress={() => null}
        accountNamesByAddress={new Map()}
        onReceive={vi.fn()}
        refreshKey={1}
      />,
    )
    expect(feedRefresh).toHaveBeenCalledTimes(1)
    expect(totalsRefresh).toHaveBeenCalledTimes(1)
  })
})

describe('AccountActivityTab — the row badge (#4288)', () => {
  function renderWithRow(overrides: Partial<AggregatedTransaction>) {
    feedMock.mockImplementation(() => ({
      ...DEFAULT_FEED,
      transactions: [tx(overrides)],
      total: 1,
      loadMore: vi.fn(),
      refresh: vi.fn(),
    }))
    renderTab()
  }

  it('labels a failed on-chain payment "Failed" — the amount is not left red and unnamed', () => {
    // A production-shaped row: the 9 Jul "Cloud vendor" shape — an errored
    // outbound transfer with no lifecycle and no wire badge, which the old
    // `transactionStatus(tx) ?? tx.statusBadge` chain left unlabelled.
    renderWithRow({
      direction: 'out',
      isError: true,
      paymentFlowStatus: null,
      statusBadge: undefined,
    })

    expect(screen.getByText('Failed')).toBeInTheDocument()
  })

  it('labels a machine payment still confirming "Confirming"', () => {
    renderWithRow({ direction: 'out', paymentFlowStatus: 'confirming_merchant' })

    expect(screen.getByText('Confirming')).toBeInTheDocument()
  })

  it('labels a needs-attention machine payment "Needs attention"', () => {
    renderWithRow({ direction: 'out', paymentFlowStatus: 'needs_attention' })

    expect(screen.getByText('Needs attention')).toBeInTheDocument()
  })

  it('labels a delegate sweep "Recovered"', () => {
    renderWithRow({
      direction: 'in',
      activityType: 'delegate_sweep',
      agentName: 'Research assistant',
      paymentId: 'sweep-id',
    })

    expect(screen.getByText('Recovered')).toBeInTheDocument()
  })
})
