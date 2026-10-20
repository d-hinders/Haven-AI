/**
 * #4098 — the account page's Activity tab: filters seeded from and written
 * to the URL next to the tab, paging through "Load more", the two distinct
 * empty states (no history vs nothing matching), the row-to-panel open by
 * mouse and keyboard, the truncated-history honesty, and the CSV export
 * carrying the fixed account plus the active filters.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

const { mockReplace, mockGetText, mockDownloadCsv, feedMock, totalsMock, urlQuery, seenFilters } =
  vi.hoisted(() => ({
    mockReplace: vi.fn(),
    mockGetText: vi.fn(),
    mockDownloadCsv: vi.fn(),
    feedMock: vi.fn(),
    totalsMock: vi.fn(),
    urlQuery: { value: '' },
    seenFilters: { value: null as Record<string, unknown> | null },
  }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: (...args: unknown[]) => mockReplace(...args) }),
  // The tab seeds its filters from the URL once, at mount — the query a
  // shared link carries.
  useSearchParams: () => new URLSearchParams(urlQuery.value),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, api: { ...actual.api, getText: (...a: unknown[]) => mockGetText(...a) } }
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
  useTransactionFilters: () => ({
    accounts: [],
    agents: [],
    tokens: [],
    loading: false,
    error: null,
  }),
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
import type { AggregatedTransaction } from '@/types/transactions'

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
  moneyIn: 10,
  moneyOut: 4,
  approx: false,
  loading: false,
  error: null,
  partial: false,
  refresh: vi.fn(),
}

function renderTab(overrides: Record<string, unknown> = {}) {
  return render(
    <AccountActivityTab
      accountId="safe-1"
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
  feedMock.mockImplementation(() => ({ ...DEFAULT_FEED, loadMore: vi.fn(), refresh: vi.fn() }))
  totalsMock.mockImplementation(() => ({ ...DEFAULT_TOTALS, refresh: vi.fn() }))
})

/**
 * The count line renders its numbers in `v2-tabular` spans (#4095's
 * typographic rule), so its text is split across elements. This finds the
 * element whose WHOLE normalized text matches — the line itself, not a
 * fragment of it.
 */
function countLine(pattern: RegExp): HTMLElement {
  return screen.getByText(
    (_, element) =>
      element instanceof HTMLElement &&
      element.tagName === 'P' &&
      (element.textContent ?? '').replace(/\s+/g, ' ').trim().match(pattern) !== null,
  )
}

/** The ledger's whole-row buttons (#4096's ledger mode). */
function ledgerRows(): HTMLElement[] {
  return screen
    .getAllByRole('button')
    .filter((element) => element.getAttribute('aria-haspopup') === 'dialog')
}

describe('AccountActivityTab — filters in the URL (#4098)', () => {
  it('seeds the filters from the URL and sends them to the feed with the fixed account', () => {
    urlQuery.value = 'search=coffee&direction=in'
    renderTab()

    expect(seenFilters.value).toMatchObject({ search: 'coffee', direction: 'in', accountId: 'safe-1' })
    // The bar echoes the seeded filter as a chip; the Account chip stays
    // hidden because the page fixes the account.
    expect(screen.getByRole('button', { name: /Search: coffee/ })).toBeInTheDocument()
    expect(screen.queryByText(/account:/i)).not.toBeInTheDocument()
  })

  it('drops a stray accountId from the URL — the page fixes the account', () => {
    urlQuery.value = 'accountId=other-account&search=coffee'
    renderTab()

    expect(seenFilters.value).toMatchObject({ search: 'coffee', accountId: 'safe-1' })
  })

  it('rewrites the URL on a filter change, next to the tab', () => {
    renderTab()

    const search = screen.getByLabelText('Search transactions')
    fireEvent.change(search, { target: { value: 'coffee' } })
    // FilterBar commits debounced (#4095) — flush the debounce.
    return waitFor(
      () => {
        expect(mockReplace).toHaveBeenCalledWith(
          '/accounts/safe-1?search=coffee',
          expect.anything(),
        )
      },
      { timeout: 2000 },
    )
  })

  it('clears every filter back to the bare account URL', () => {
    urlQuery.value = 'search=coffee'
    renderTab()

    fireEvent.click(screen.getByRole('button', { name: /Search: coffee/ }))
    expect(mockReplace).toHaveBeenCalledWith('/accounts/safe-1', expect.anything())
  })
})

describe('AccountActivityTab — result line and paging (#4098)', () => {
  it('says "Showing X of Y" while the unfiltered ledger has more to load', () => {
    feedMock.mockImplementation(() => ({
      ...DEFAULT_FEED,
      total: 5,
      hasMore: true,
      loadMore: vi.fn(),
      refresh: vi.fn(),
    }))
    renderTab()

    expect(countLine(/Showing 2 of 5/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument()
  })

  it('calls the feed for the next page on Load more', () => {
    const loadMore = vi.fn()
    feedMock.mockImplementation(() => ({
      ...DEFAULT_FEED,
      total: 5,
      hasMore: true,
      loadMore,
      refresh: vi.fn(),
    }))
    renderTab()

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(loadMore).toHaveBeenCalledTimes(1)
  })

  it('says the server count, not "N matching", when a filter narrows the set (#4098 owner decision)', () => {
    urlQuery.value = 'search=coffee'
    feedMock.mockImplementation(() => ({
      ...DEFAULT_FEED,
      total: 3,
      hasMore: true,
      loadMore: vi.fn(),
      refresh: vi.fn(),
    }))
    renderTab()

    // The Transactions page's result line: "Showing X of Y" while more pages
    // remain — filtered or not, `total` is the server's filtered count.
    expect(countLine(/Showing 2 of 3/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('matching')
  })

  it('qualifies the counts instead of claiming completeness when the feed is capped', () => {
    feedMock.mockImplementation(() => ({
      ...DEFAULT_FEED,
      truncated: true,
      loadMore: vi.fn(),
      refresh: vi.fn(),
    }))
    renderTab()

    expect(
      screen.getByText(/may not be your full history/i),
    ).toBeInTheDocument()
  })

  it('shows the server-side in/out totals for the filtered set', () => {
    renderTab()

    expect(screen.getByText(/Money in/)).toBeInTheDocument()
    expect(screen.getByText(/Money out/)).toBeInTheDocument()
  })

  it('hides the totals while they load — no figure beats a wrong one', () => {
    totalsMock.mockImplementation(() => ({ ...DEFAULT_TOTALS, loading: true, refresh: vi.fn() }))
    renderTab()

    expect(screen.queryByText(/Money in/)).not.toBeInTheDocument()
  })
})

describe('AccountActivityTab — empty states (#4098)', () => {
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

  it('shows "No activity matches these filters" with Clear filters when a filter matches nothing', () => {
    urlQuery.value = 'search=coffee'
    feedMock.mockImplementation(() => ({
      ...DEFAULT_FEED,
      transactions: [],
      total: 0,
      loadMore: vi.fn(),
      refresh: vi.fn(),
    }))
    renderTab()

    expect(screen.getByText('No activity matches these filters')).toBeInTheDocument()
    expect(screen.getByText('Adjust or clear filters to widen the history.')).toBeInTheDocument()
    expect(screen.queryByText('No activity yet')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(mockReplace).toHaveBeenCalledWith('/accounts/safe-1', expect.anything())
  })
})

describe('AccountActivityTab — rows and the detail panel (#4098)', () => {
  it('opens the detail panel by mouse and by keyboard', () => {
    renderTab()

    // #4096's ledger mode: every row is a whole-row button (aria-haspopup
    // dialog). Mouse first…
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

  it('#4099: names a transfer between own accounts on both sides, and says "by you" for a recorded owner send', () => {
    const main = '0x' + 'aa'.repeat(20)
    const reserve = '0x' + 'dd'.repeat(20)
    const ownAccounts = new Map([
      [`${main}:8453`, 'Main'],
      [`${reserve}:8453`, 'Reserve'],
    ])
    const transfer = { from: main, to: reserve }

    // Sending side: Main's ledger.
    feedMock.mockImplementation(() => ({
      ...DEFAULT_FEED,
      transactions: [tx({ ...transfer, hash: '0x01', direction: 'out', initiatedBy: 'human' })],
      total: 1,
    }))
    const { unmount } = renderTab({ accountNamesByAddress: ownAccounts })
    let row = ledgerRows()[0]
    expect(row).toHaveTextContent('Payment sent by you')
    expect(row).toHaveTextContent(/From Main\s*→\s*To Reserve/)
    expect(row).not.toHaveTextContent('New recipient')
    unmount()

    // Receiving side: Reserve's ledger, the same transfer inbound.
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
    // The movement line prints its own "From": the sender goes in bare, so
    // the row never reads "From From Main".
    expect(row).toHaveTextContent(/From Main\s*→\s*To Reserve/)
    expect(row).not.toHaveTextContent('From From')
    expect(row).not.toHaveTextContent('Deposit')
  })
})

describe('AccountActivityTab — CSV export (#4098)', () => {
  it('carries the fixed account and the active filters on the export request', async () => {
    urlQuery.value = 'search=coffee'
    mockGetText.mockResolvedValue('﻿hash\r\n"0xabc"')
    renderTab()

    fireEvent.click(screen.getByRole('button', { name: /export csv/i }))
    await waitFor(() => expect(mockDownloadCsv).toHaveBeenCalledTimes(1))
    expect(mockGetText).toHaveBeenCalledWith(
      expect.stringContaining('/transactions/export.csv?'),
    )
    expect(mockGetText).toHaveBeenCalledWith(expect.stringContaining('accountId=safe-1'))
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
