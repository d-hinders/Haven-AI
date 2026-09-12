/**
 * `ConnectionsCard` (#2868) through the REAL hooks with the API client
 * mocked: the list, Connect → consent URL, Disconnect behind a confirmation
 * that says history stays, Settings inline, and the OAuth return — the
 * backfill dialog on a first connect, the outcome sentences otherwise.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '@/context/LocaleContext'
import { COMING_SOON, connection, provider } from './fixtures'

const { mockApi, mockReplace, searchParamsRef } = vi.hoisted(() => ({
  mockApi: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  mockReplace: vi.fn(),
  searchParamsRef: { current: new URLSearchParams() },
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ApiRequestError: actual.ApiRequestError, api: mockApi }
})
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: mockReplace }),
  useSearchParams: () => searchParamsRef.current,
}))
vi.mock('@/hooks/useScrollEdgeCue', () => ({ useScrollEdgeCue: () => false }))

import { ConnectionsCard, readConnectOutcome } from '@/components/accounting/ConnectionsCard'

const PROVIDERS = [provider(), ...COMING_SOON]

function serve(connections: ReturnType<typeof connection>[]) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/accounting/providers') return Promise.resolve({ providers: PROVIDERS })
    if (url === '/accounting/connections') return Promise.resolve({ connections })
    return Promise.reject(new Error(`unexpected GET ${url}`))
  })
}

function renderCard() {
  return render(
    <LocaleProvider>
      <ConnectionsCard />
    </LocaleProvider>,
  )
}

const fortnoxActions = () => screen.getByTestId('connection-actions-fortnox')

describe('readConnectOutcome', () => {
  it('reads the callback query and ignores anything else', () => {
    expect(readConnectOutcome(new URLSearchParams('provider=fortnox&connect=connected'))).toEqual({
      provider: 'fortnox',
      connect: 'connected',
      reason: null,
    })
    expect(readConnectOutcome(new URLSearchParams('provider=fortnox&connect=error&reason=unsupported_currency'))).toEqual({
      provider: 'fortnox',
      connect: 'error',
      reason: 'unsupported_currency',
    })
    expect(readConnectOutcome(new URLSearchParams('provider=fortnox&connect=weird'))).toBeNull()
    expect(readConnectOutcome(new URLSearchParams('connect=connected'))).toBeNull()
    expect(readConnectOutcome(null)).toBeNull()
  })
})

describe('ConnectionsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    searchParamsRef.current = new URLSearchParams()
  })

  it('lists every provider: Fortnox with its state, the rest Coming soon', async () => {
    serve([connection()])
    renderCard()
    expect(await screen.findByText(/Connected to Ada Lovelace AB/)).toBeInTheDocument()
    for (const p of COMING_SOON) {
      const row = screen.getByTestId(`connection-row-${p.id}`)
      expect(within(row).getByText('Coming soon')).toBeInTheDocument()
      expect(within(row).getByRole('button', { name: 'Connect' })).toBeDisabled()
    }
    expect(screen.getByRole('heading', { name: 'Accounting' })).toBeInTheDocument()
    expect(screen.getByText(/appear there with payment evidence attached; your accountant books them/)).toBeInTheDocument()
    // The responsibility line the feed page's connect card carried, kept
    // under the section header (#2903 review).
    expect(
      screen.getByText(/Haven provides data tooling, not accounting or tax advice\..*you and your accountant remain responsible for coding, correctness, and filing/),
    ).toBeInTheDocument()
  })

  it('keeps the rows rendered during a refetch — the skeleton is for the first load only (#2903)', async () => {
    serve([connection()])
    // The DELETE resolves at once; the re-list it triggers is held open so
    // the refetch window is observable.
    let releaseRelist: (() => void) | null = null
    mockApi.delete.mockResolvedValue(undefined)
    renderCard()
    await screen.findByText(/Connected to Ada Lovelace AB/)
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/accounting/providers') return Promise.resolve({ providers: PROVIDERS })
      if (url === '/accounting/connections') {
        return new Promise((resolve) => {
          releaseRelist = () => resolve({ connections: [connection({ status: 'disconnected', isActiveDestination: false })] })
        })
      }
      return Promise.reject(new Error(`unexpected GET ${url}`))
    })
    fireEvent.click(within(fortnoxActions()).getByRole('button', { name: 'Disconnect' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/accounting/connections/fortnox'))
    await waitFor(() => expect(releaseRelist).not.toBeNull())
    // Mid-refetch: the rows are still there, no skeleton, and the region says it is busy.
    expect(screen.getByTestId('connection-row-fortnox')).toBeInTheDocument()
    expect(screen.getByTestId('connection-row-igdrasil')).toBeInTheDocument()
    expect(screen.queryByRole('status', { busy: true })).toBeNull()
    expect(screen.getByTestId('connection-list')).toHaveAttribute('aria-busy', 'true')
    releaseRelist!()
    expect(await screen.findByText(/What was fed earlier stays in Haven/)).toBeInTheDocument()
    expect(screen.getByTestId('connection-list')).not.toHaveAttribute('aria-busy')
  })

  it('Connect fetches the consent URL for the provider', async () => {
    serve([])
    mockApi.post.mockResolvedValue({ url: 'https://apps.fortnox.se/oauth-v1/auth?state=s' })
    const original = window.location
    const assigned: string[] = []
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, set href(v: string) { assigned.push(v) } },
    })
    try {
      renderCard()
      fireEvent.click(await within(await screen.findByTestId('connection-actions-fortnox')).findByRole('button', { name: 'Connect' }))
      await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/accounting/connections/fortnox/connect-url'))
      await waitFor(() => expect(assigned).toEqual(['https://apps.fortnox.se/oauth-v1/auth?state=s']))
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original })
    }
  })

  it('Disconnect asks first, says history stays, and only the confirmation calls DELETE', async () => {
    serve([connection()])
    mockApi.delete.mockResolvedValue(undefined)
    renderCard()
    fireEvent.click(await within(await screen.findByTestId('connection-actions-fortnox')).findByRole('button', { name: 'Disconnect' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Disconnect Fortnox?')
    expect(dialog).toHaveTextContent('the feed history stays in Haven')
    expect(mockApi.delete).not.toHaveBeenCalled()

    // Cancel is a real way out.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep connected' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(mockApi.delete).not.toHaveBeenCalled()

    fireEvent.click(within(fortnoxActions()).getByRole('button', { name: 'Disconnect' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/accounting/connections/fortnox'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('Settings opens the inline form under the row and saves through PATCH', async () => {
    serve([connection()])
    // The route answers the merged row with a NEW updatedAt; the form must
    // keep its Saved line rather than remount on it.
    mockApi.patch.mockResolvedValue({
      connection: connection({ settings: { suggestedAccount: '6540', autoFeed: true }, updatedAt: '2026-09-12T10:00:00.000Z' }),
    })
    renderCard()
    fireEvent.click(await within(await screen.findByTestId('connection-actions-fortnox')).findByRole('button', { name: 'Settings' }))
    const form = screen.getByTestId('connection-settings-fortnox')
    fireEvent.change(within(form).getByLabelText('Suggested account'), { target: { value: '6540' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/accounting/connections/fortnox/settings', {
        suggested_account: '6540',
        auto_feed: true,
      }),
    )
    expect(await within(form).findByRole('status')).toHaveTextContent('Saved.')
    fireEvent.click(within(fortnoxActions()).getByRole('button', { name: 'Hide settings' }))
    expect(screen.queryByTestId('connection-settings-fortnox')).toBeNull()
  })

  describe('the OAuth return', () => {
    it('connect=connected on a never-pushed connection opens the backfill choice and strips the query', async () => {
      searchParamsRef.current = new URLSearchParams('provider=fortnox&connect=connected')
      serve([connection({ lastPushAt: null })])
      mockApi.post.mockResolvedValue({ feedFrom: '2026-01-01T00:00:00.000Z', fed: 1 })
      renderCard()
      const dialog = await screen.findByRole('dialog')
      expect(dialog).toHaveTextContent('Include earlier payments?')
      expect(mockReplace).toHaveBeenCalledWith('/settings')
      expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Fortnox is connected.')

      fireEvent.click(within(dialog).getByRole('radio', { name: /Include payments since/ }))
      fireEvent.change(within(dialog).getByLabelText('Date (YYYY-MM-DD)'), { target: { value: '2026-01-01' } })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }))
      await waitFor(() =>
        expect(mockApi.post).toHaveBeenCalledWith('/accounting/connections/fortnox/backfill', { since: '2026-01-01' }),
      )
    })

    it('the backfill choice is asked ONCE: "Feed from now", then Save in Settings does not re-open it (#2903)', async () => {
      // Reproduced on the PR: `outcome` was never consumed, so any later
      // change to the connection list — here the in-place row swap a Save
      // does — re-ran the effect against a row that still had
      // `lastPushAt === null` and brought the dialog back.
      searchParamsRef.current = new URLSearchParams('provider=fortnox&connect=connected')
      serve([connection({ lastPushAt: null })])
      mockApi.patch.mockResolvedValue({
        connection: connection({ lastPushAt: null, settings: { suggestedAccount: '6540', autoFeed: true }, updatedAt: '2026-09-12T10:00:00.000Z' }),
      })
      renderCard()
      const dialog = await screen.findByRole('dialog')
      expect(dialog).toHaveTextContent('Include earlier payments?')
      expect(within(dialog).getByRole('radio', { name: /Feed from now/ })).toBeChecked()
      fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(mockApi.post).not.toHaveBeenCalled()

      fireEvent.click(within(fortnoxActions()).getByRole('button', { name: 'Settings' }))
      const form = screen.getByTestId('connection-settings-fortnox')
      fireEvent.change(within(form).getByLabelText('Suggested account'), { target: { value: '6540' } })
      fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
      expect(await within(form).findByRole('status')).toHaveTextContent('Saved.')
      // The row was swapped (still never pushed) — and the dialog stays gone.
      expect(screen.queryByRole('dialog')).toBeNull()
      // The outcome sentence itself is still on screen: consumed is not erased.
      expect(screen.getByText('Fortnox is connected.')).toBeInTheDocument()
    })

    it('connect=connected on a connection that already fed is a re-consent: no dialog', async () => {
      searchParamsRef.current = new URLSearchParams('provider=fortnox&connect=connected')
      serve([connection()])
      renderCard()
      expect(await screen.findByText('Fortnox is connected.')).toBeInTheDocument()
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('connect=denied says nothing was connected', async () => {
      searchParamsRef.current = new URLSearchParams('provider=fortnox&connect=denied')
      serve([])
      renderCard()
      expect(await screen.findByRole('alert')).toHaveTextContent('You declined the Fortnox consent. Nothing was connected.')
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('connect=error&reason=unsupported_currency says Haven currently feeds SEK ledgers only', async () => {
      searchParamsRef.current = new URLSearchParams('provider=fortnox&connect=error&reason=unsupported_currency')
      serve([])
      renderCard()
      expect(await screen.findByRole('alert')).toHaveTextContent('Haven currently feeds SEK ledgers only')
    })

    it('connect=error without a reason is the generic sentence', async () => {
      searchParamsRef.current = new URLSearchParams('provider=fortnox&connect=error')
      serve([])
      renderCard()
      expect(await screen.findByRole('alert')).toHaveTextContent('We could not connect Fortnox.')
    })
  })

  it('a failed listing is one sentence, not a crash', async () => {
    mockApi.get.mockRejectedValue(new Error('down'))
    renderCard()
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not load accounting connections.')
  })
})
