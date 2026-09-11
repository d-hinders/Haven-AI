/**
 * The export control's two new states (#2871): busy while the backend builds
 * the file, and the failure banner when it refuses.
 *
 * The design review of #2871 found that nothing — pixel, test or render —
 * checked either state. This is the test half; the render half is recorded as
 * unverified in the PR body.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from '@/lib/api'

const { mockGetText, mockDownloadCsv } = vi.hoisted(() => ({
  mockGetText: vi.fn(),
  mockDownloadCsv: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, api: { getText: (...a: unknown[]) => mockGetText(...a) } }
})
vi.mock('@/lib/transaction-csv', () => ({
  downloadCsv: (...a: unknown[]) => mockDownloadCsv(...a),
  buildCsvFilename: () => 'haven-transactions-20260911.csv',
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      safes: [
        { id: 'safe-1', safe_address: '0x' + 'aa'.repeat(20), chain_id: 8453, name: 'Main' },
      ],
    },
  }),
}))
vi.mock('@/hooks/useContacts', () => ({ useContacts: () => ({ resolveAddress: () => null }) }))
vi.mock('@/hooks/useActiveChain', () => ({
  useChainScope: () => ({ scope: 'all', setScope: vi.fn() }),
}))
vi.mock('@/hooks/useTransactionFilters', () => ({
  useTransactionFilters: () => ({
    safes: [],
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
  safeId: 'safe-1',
  safeAddress: '0x' + 'aa'.repeat(20),
  safeName: 'Main',
}

const { feedState } = vi.hoisted(() => ({
  feedState: { partialFailure: false, truncated: false },
}))

vi.mock('@/hooks/useTransactionsFeed', () => ({
  useTransactionsFeed: () => ({
    transactions: [TX],
    total: 1,
    loadingInitial: false,
    loadingMore: false,
    hasMore: false,
    error: null,
    partialFailure: feedState.partialFailure,
    truncated: feedState.truncated,
    failedSafeIds: [],
    loadMore: vi.fn(),
    refresh: vi.fn(),
  }),
}))

const TransactionsClient = (await import('../TransactionsClient')).default

beforeEach(() => {
  mockGetText.mockReset()
  mockDownloadCsv.mockReset()
  feedState.partialFailure = false
  feedState.truncated = false
})

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
    expect(mockDownloadCsv).toHaveBeenCalledWith(
      '﻿settled_at\r\n"x"',
      'haven-transactions-20260911.csv',
    )
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

    const notice = await screen.findByRole('status')
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

    const notice = await screen.findByRole('status')
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

    // The direction filter is a dropdown, not a select: open it, pick Outgoing.
    fireEvent.click(screen.getByRole('button', { name: /direction:/i }))
    fireEvent.click(screen.getByRole('button', { name: /^outgoing$/i }))

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('says so when the feed is capped at the explorer window', async () => {
    // #2882: without this the page presents a capped list as the whole
    // history, and the export inherits the same silent claim.
    feedState.truncated = true
    render(<TransactionsClient />)

    expect(await screen.findByText(/Older transactions aren.t included/i)).toBeInTheDocument()
    expect(screen.getByText(/not your full history/i)).toBeInTheDocument()
    // The header's blanket claim must soften with it — it is the louder of
    // the two, and the one a user reads first.
    expect(screen.getByText('Recent activity across your accounts.')).toBeInTheDocument()
    expect(screen.queryByText('All activity across your accounts.')).toBeNull()
  })

  it('says nothing when the feed is complete', () => {
    render(<TransactionsClient />)

    expect(screen.queryByText(/Older transactions aren.t included/i)).toBeNull()
    expect(screen.getByText('All activity across your accounts.')).toBeInTheDocument()
  })
})