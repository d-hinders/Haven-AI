/**
 * The export control's two new states (#2871): busy while the backend builds
 * the file, and the failure banner when it refuses.
 *
 * The design review of #2871 found that nothing — pixel, test or render —
 * checked either state. This is the test half; the render half is recorded as
 * unverified in the PR body.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from '@/lib/api'

const { mockGetText, mockGet, mockDownloadCsv, urlState } = vi.hoisted(() => ({
  mockGetText: vi.fn(),
  mockGet: vi.fn(),
  mockDownloadCsv: vi.fn(),
  // Reached through the account deep link by default, which seeds the
  // account filter; the export request must carry the same key (#2913).
  urlState: { query: 'accountId=safe-1' },
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: {
      getText: (...a: unknown[]) => mockGetText(...a),
      // Only the unfiltered total behind "{shown} of {total}" (#4111).
      get: (...a: unknown[]) => mockGet(...a),
    },
  }
})
vi.mock('@/lib/transaction-csv', () => ({
  downloadCsv: (...a: unknown[]) => mockDownloadCsv(...a),
  buildCsvFilename: () => 'haven-transactions-20260911.csv',
}))
vi.mock('next/navigation', () => ({
  usePathname: () => '/transactions',
  useSearchParams: () => new URLSearchParams(urlState.query),
}))
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      accounts: [
        { id: 'safe-1', account_address: '0x' + 'aa'.repeat(20), chain_id: 8453, name: 'Main' },
      ],
    },
  }),
}))
vi.mock('@/hooks/useContacts', () => ({ useContacts: () => ({ resolveAddress: () => null }) }))
// `useChainScope` is deliberately NOT mocked: the network default is part of
// what this page renders (#3719 — every network, no active chain to follow).
vi.mock('@/hooks/useTransactionFilters', () => ({
  useTransactionFilters: () => ({
    accounts: [],
    agents: [],
    tokens: [],
    loading: false,
    error: null,
  }),
}))

const TX = {
  hash: '0xabc',
  type: 'erc20' as const,
  from: '0x' + 'bb'.repeat(20),
  to: '0x' + 'aa'.repeat(20),
  value: '1000000',
  valueFormatted: '1.00',
  asset: 'USDC',
  decimals: 6,
  direction: 'in' as const,
  timestamp: 1_778_240_999,
  blockNumber: 1,
  isError: false,
  chainId: 8453,
  accountId: 'safe-1',
  accountAddress: '0x' + 'aa'.repeat(20),
  accountName: 'Main',
}

const { feedState } = vi.hoisted(() => ({
  feedState: { partialFailure: false, truncated: false, empty: false },
}))

vi.mock('@/hooks/useTransactionsFeed', () => ({
  browserTimeZone: () => 'Europe/Stockholm',
  useTransactionsFeed: () => ({
    transactions: feedState.empty ? [] : [TX],
    total: feedState.empty ? 0 : 1,
    loadingInitial: false,
    loadingMore: false,
    hasMore: false,
    error: null,
    partialFailure: feedState.partialFailure,
    truncated: feedState.truncated,
    failedAccountIds: [],
    loadMore: vi.fn(),
    refresh: vi.fn(),
  }),
}))

const TransactionsClient = (await import('../TransactionsClient')).default

beforeEach(() => {
  mockGetText.mockReset()
  mockGet.mockReset()
  mockGet.mockResolvedValue({ total: 40 })
  mockDownloadCsv.mockReset()
  urlState.query = 'accountId=safe-1'
  window.history.replaceState(null, '', '/transactions')
  feedState.partialFailure = false
  feedState.truncated = false
  feedState.empty = false
})

async function exportNoticeRegion(): Promise<HTMLElement> {
  const headline = await screen.findByText(/^Nothing to export/)
  const region = headline.closest<HTMLElement>('[role="status"]')
  expect(region).not.toBeNull()
  return region!
}

function exportButton(): HTMLElement {
  return screen.getByRole('button', { name: /export csv/i })
}

describe('TransactionsClient — CSV export (#2871)', () => {
  it('asks the backend for the file and downloads what comes back', async () => {
    mockGetText.mockResolvedValue('﻿settled_at\r\n"x"')
    render(<TransactionsClient />)

    fireEvent.click(exportButton())

    await waitFor(() => expect(mockDownloadCsv).toHaveBeenCalledTimes(1))
    expect(mockGetText).toHaveBeenCalledWith(expect.stringContaining('/transactions/export.csv'))
    // The deep link and the export request both carry the renamed query key
    // (#2913): `?accountId=`, read by the server from #2907 onward.
    expect(mockGetText).toHaveBeenCalledWith(expect.stringContaining('accountId=safe-1'))
    expect(mockDownloadCsv).toHaveBeenCalledWith(
      '﻿settled_at\r\n"x"',
      'haven-transactions-20260911.csv',
    )
  })

  it('starts on every network, and the export asks for no chain (#3719)', async () => {
    mockGetText.mockResolvedValue('\ufeffsettled_at\r\n"x"')
    render(<TransactionsClient />)

    // The Network facet only shows with accounts on 2+ chains (one option
    // hides it); the scope it would show is what the export request carries,
    // so read it there.
    fireEvent.click(exportButton())
    await waitFor(() => expect(mockGetText).toHaveBeenCalledTimes(1))
    expect(mockGetText).toHaveBeenCalledWith(expect.not.stringContaining('chainId='))
  })

  it('marks the control busy while the request is in flight', async () => {
    let release: (v: string) => void = () => {}
    mockGetText.mockReturnValue(new Promise<string>((resolve) => { release = resolve }))
    render(<TransactionsClient />)

    fireEvent.click(exportButton())

    // The label swap is the visible half; aria-busy is what makes it audible.
    const busy = await screen.findByRole('button', { name: /preparing/i })
    expect(busy).toBeDisabled()
    expect(busy).toHaveAttribute('aria-busy', 'true')

    release('﻿settled_at')
    await waitFor(() => expect(exportButton()).not.toBeDisabled())
  })

  it('shows the row-cap refusal in full, in a live region', async () => {
    const details =
      'This export would contain 10,001 rows; the limit is 10,000. Narrow the ' +
      'filters — by account, agent, token, network or direction — and export again.'
    mockGetText.mockRejectedValue(
      new ApiRequestError('Export too large', 413, { error: 'Export too large', details }),
    )
    render(<TransactionsClient />)

    fireEvent.click(exportButton())

    // The three-word `error` alone tells the user nothing to do; `details`
    // carries the count, the limit and the way out.
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Export too large')
    expect(alert).toHaveTextContent('10,001')
    expect(alert).toHaveTextContent('Narrow the filters')
    expect(mockDownloadCsv).not.toHaveBeenCalled()
  })

  it('reports an empty result instead of downloading a header-only file', async () => {
    // The button is gated on the server's `total`, which does not know about
    // the in-memory direction/network filters the export request DOES send —
    // so an enabled button can legitimately produce no rows.
    mockGetText.mockResolvedValue('\uFEFFsettled_at,type,status')
    render(<TransactionsClient />)

    fireEvent.click(exportButton())

    // The toolbar's count is a status region too (#4111); the notice is the
    // one carrying the export's words.
    const notice = await exportNoticeRegion()
    expect(notice).toHaveTextContent('Nothing to export')
    expect(notice).toHaveTextContent('No transactions match these filters')
    expect(mockDownloadCsv).not.toHaveBeenCalled()
    // Not a failure: it must not be painted as one.
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not blame the filters when the accounts themselves failed to load', async () => {
    // Same empty body, different cause. Saying "nothing matched" during an
    // explorer outage is a confident wrong diagnosis.
    feedState.partialFailure = true
    mockGetText.mockResolvedValue('\uFEFFsettled_at,type,status')
    render(<TransactionsClient />)

    fireEvent.click(exportButton())

    // The toolbar's count is a status region too (#4111); the notice is the
    // one carrying the export's words.
    const notice = await exportNoticeRegion()
    expect(notice).toHaveTextContent('Some accounts failed to load')
    expect(notice).not.toHaveTextContent('No transactions match these filters')
    expect(mockDownloadCsv).not.toHaveBeenCalled()
  })

  it('does not surface a raw server string for any other failure', async () => {
    mockGetText.mockRejectedValue(new ApiRequestError('Internal Server Error', 500, {}))
    render(<TransactionsClient />)

    fireEvent.click(exportButton())

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The export could not be generated.')
    expect(alert).not.toHaveTextContent('Internal Server Error')
  })

  it('clears the banner when the filters change, since that is the advice it gave', async () => {
    mockGetText.mockRejectedValue(new ApiRequestError('Export too large', 413, {}))
    render(<TransactionsClient />)

    fireEvent.click(exportButton())
    await screen.findByRole('alert')

    // The direction filter is a facet menu (#4111): open it, pick Outgoing.
    fireEvent.click(screen.getByRole('button', { name: /^direction:/i }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^outgoing$/i }))

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('says so when the feed is capped at the explorer window', async () => {
    // #2882: without this the page presents a capped list as the whole
    // history, and the export inherits the same silent claim.
    feedState.truncated = true
    render(<TransactionsClient />)

    expect(
      await screen.findByText(/Counts and exports cover the transactions loaded here/i),
    ).toBeInTheDocument()
    // Hedged, not flat: an account holding exactly one window on an
    // Etherscan-shaped leg would make a flat claim false.
    expect(screen.getByText(/may\s+not be your full history/i)).toBeInTheDocument()
    // The header's blanket claim must soften with it — it is the louder of
    // the two, and the one a user reads first.
    expect(screen.getByText('Recent activity across your accounts.')).toBeInTheDocument()
    expect(screen.queryByText('All activity across your accounts.')).toBeNull()
  })

  it('says nothing when the feed is complete', () => {
    render(<TransactionsClient />)

    expect(
      screen.queryByText(/Counts and exports cover the transactions loaded here/i),
    ).toBeNull()
    expect(screen.getByText('All activity across your accounts.')).toBeInTheDocument()
  })
})

describe('TransactionsClient — URL and export params (#4111)', () => {
  it('sends the search term, and every other filter, on the export request', async () => {
    urlState.query =
      'q=savings&accountId=safe-1&agentId=agent-1&tokenKey=8453%3A0xusdc&direction=out&chainId=8453&period=30d'
    mockGetText.mockResolvedValue('\ufeffsettled_at\r\n"x"')
    render(<TransactionsClient />)

    fireEvent.click(exportButton())
    await waitFor(() => expect(mockGetText).toHaveBeenCalledTimes(1))
    const url = String(mockGetText.mock.calls[0][0])
    const params = new URL(url, 'https://haven.test').searchParams
    // The URL says `q`; the API is read as `search` — the codec and the API
    // param builder are separate, so the rename cannot drop it from the file.
    expect(params.get('search')).toBe('savings')
    expect(params.has('q')).toBe(false)
    expect(params.get('accountId')).toBe('safe-1')
    expect(params.get('agentId')).toBe('agent-1')
    expect(params.get('tokenKey')).toBe('8453:0xusdc')
    expect(params.get('direction')).toBe('out')
    expect(params.get('chainId')).toBe('8453')
    expect(params.get('period')).toBe('30d')
  })

  it('sends a custom range with the time zone it is cut in', async () => {
    urlState.query = 'from=2026-09-01&to=2026-09-30'
    mockGetText.mockResolvedValue('\ufeffsettled_at\r\n"x"')
    render(<TransactionsClient />)

    fireEvent.click(exportButton())
    await waitFor(() => expect(mockGetText).toHaveBeenCalledTimes(1))
    const params = new URL(String(mockGetText.mock.calls[0][0]), 'https://haven.test').searchParams
    expect(params.get('from')).toBe('2026-09-01')
    expect(params.get('to')).toBe('2026-09-30')
    expect(params.get('tz')).toBe('Europe/Stockholm')
    expect(params.has('period')).toBe(false)
  })

  it('applies a legacy ?search= link and rewrites the address to q', async () => {
    urlState.query = 'search=savings&accountId=safe-1'
    window.history.replaceState(null, '', '/transactions?search=savings&accountId=safe-1')
    mockGetText.mockResolvedValue('\ufeffsettled_at\r\n"x"')
    render(<TransactionsClient />)

    // Applied: the field shows it and the export carries it.
    expect(screen.getByRole('searchbox', { name: 'Search transactions' })).toHaveValue('savings')
    // Rewritten: the URL names the search `q` and the old key is gone, while
    // the key it does not rename keeps its value.
    await waitFor(() => expect(window.location.search).toContain('q=savings'))
    const params = new URLSearchParams(window.location.search)
    expect(params.has('search')).toBe(false)
    expect(params.get('accountId')).toBe('safe-1')

    fireEvent.click(exportButton())
    await waitFor(() => expect(mockGetText).toHaveBeenCalledTimes(1))
    expect(mockGetText).toHaveBeenCalledWith(expect.stringContaining('search=savings'))
  })

  it('keeps every other key in its old name and format when a filter changes', async () => {
    urlState.query = 'accountId=safe-1&period=7d'
    window.history.replaceState(null, '', '/transactions?accountId=safe-1&period=7d')
    render(<TransactionsClient />)

    fireEvent.click(screen.getByRole('button', { name: /^direction:/i }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^incoming$/i }))

    await waitFor(() => expect(window.location.search).toContain('direction=in'))
    const params = new URLSearchParams(window.location.search)
    expect(params.get('accountId')).toBe('safe-1')
    expect(params.get('period')).toBe('7d')
  })

  it('reads the standard count: unfiltered, then filtered against the unfiltered total', async () => {
    urlState.query = ''
    const { unmount } = render(<TransactionsClient />)
    expect(screen.getByTestId('list-toolbar-count')).toHaveTextContent(/^1 transaction$/)
    // Unfiltered, the feed's total is the figure: nothing extra is read.
    expect(mockGet).not.toHaveBeenCalled()
    unmount()

    urlState.query = 'accountId=safe-1'
    render(<TransactionsClient />)
    await waitFor(() =>
      expect(screen.getByTestId('list-toolbar-count')).toHaveTextContent(/^1 of 40 transactions$/),
    )
    // Both numbers are server figures: the unfiltered one comes from one
    // filter-free read.
    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(mockGet).toHaveBeenCalledWith('/transactions?offset=0&limit=1')
  })

  it('shows the standard no-match state, and its Clear filters returns to the default', async () => {
    feedState.empty = true
    urlState.query = 'q=zzz&direction=in'
    window.history.replaceState(null, '', '/transactions?q=zzz&direction=in')
    render(<TransactionsClient />)

    expect(screen.getByText('No transactions match these filters')).toBeInTheDocument()
    expect(
      screen.getByText('Try a different search, or clear filters to see everything.'),
    ).toBeInTheDocument()
    // The toolbar stays, so the cause stays editable.
    expect(screen.getByTestId('list-toolbar')).toBeInTheDocument()

    // Two Clear filters: the toolbar's and the no-match state's. Either one
    // returns to the page default — no search, every facet All, All time.
    const noMatch = screen.getByTestId('transactions-no-match')
    fireEvent.click(within(noMatch).getByRole('button', { name: 'Clear filters' }))
    await waitFor(() => expect(window.location.search).toBe(''))
    expect(screen.getByRole('searchbox', { name: 'Search transactions' })).toHaveValue('')
  })

  it('drops a chainId that is not a network id instead of showing it as a filter', async () => {
    urlState.query = 'chainId=abc'
    window.history.replaceState(null, '', '/transactions?chainId=abc')
    render(<TransactionsClient />)

    await waitFor(() => expect(window.location.search).toBe(''))
    expect(screen.queryByRole('button', { name: /^Remove Network/ })).toBeNull()
    // Unfiltered once repaired: the count is the plain total.
    await waitFor(() =>
      expect(screen.getByTestId('list-toolbar-count')).toHaveTextContent(/^1 transaction$/),
    )
  })

  it('shows only the direction half the Direction filter leaves open', () => {
    urlState.query = 'direction=out'
    render(<TransactionsClient />)

    const page = document.body.textContent ?? ''
    expect(page).toMatch(/0\s*sent/)
    expect(page).not.toMatch(/\d\s*received/)
  })
})
