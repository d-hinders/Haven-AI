/**
 * `/accounting` after #2868: the feed page keeps the sync rows and points at
 * Settings for the connection; the OAuth callback still lands here
 * (`routes/accounting-connections.ts` redirects to `/accounting?…`), so the
 * outcome query is forwarded to `/settings` verbatim — including
 * `reason=unsupported_currency`, which Settings turns into a sentence naming
 * the supported ledger currencies (#2877).
 */
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '@/context/LocaleContext'

const { mockReplace, searchParamsRef, mockFeed } = vi.hoisted(() => ({
  mockReplace: vi.fn(),
  searchParamsRef: { current: new URLSearchParams() },
  mockFeed: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: mockReplace }),
  useSearchParams: () => searchParamsRef.current,
}))
vi.mock('@/hooks/useAccountingFeed', () => ({ useAccountingFeed: () => mockFeed() }))

import AccountingPage from '@/app/(authenticated)/accounting/page'

function feed(overrides: Record<string, unknown> = {}) {
  return {
    status: { hosted: true, flagEnabled: true, liveSyncReady: true, available: true, connected: true, syncs: [] },
    loading: false,
    error: null,
    refetch: vi.fn(),
    sync: vi.fn(),
    verify: vi.fn(),
    reopen: vi.fn(),
    ...overrides,
  }
}

function renderPage() {
  return render(
    <LocaleProvider>
      <AccountingPage />
    </LocaleProvider>,
  )
}

describe('/accounting after the connection moved to Settings (#2868)', () => {
  beforeEach(() => {
    mockReplace.mockReset()
    searchParamsRef.current = new URLSearchParams()
    mockFeed.mockReturnValue(feed())
  })

  it('offers no Connect / Disconnect and points at Settings instead', () => {
    renderPage()
    expect(screen.queryByRole('button', { name: /^(Dis)?connect$/ })).toBeNull()
    expect(screen.getByRole('link', { name: 'Open Settings' })).toHaveAttribute('href', '/settings')
    expect(screen.getByText('Manage your accounting connection in Settings.')).toBeInTheDocument()
    // Positive control: the feed itself is still here.
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeInTheDocument()
  })

  it.each([
    ['provider=fortnox&connect=connected', '/settings?provider=fortnox&connect=connected'],
    ['provider=fortnox&connect=denied', '/settings?provider=fortnox&connect=denied'],
    [
      'provider=fortnox&connect=error&reason=unsupported_currency',
      '/settings?provider=fortnox&connect=error&reason=unsupported_currency',
    ],
  ])('forwards the callback query %s to Settings', async (query, target) => {
    searchParamsRef.current = new URLSearchParams(query)
    renderPage()
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(target))
  })

  it('forwards even while the feed status is still loading, and when the add-on is hidden', async () => {
    searchParamsRef.current = new URLSearchParams('provider=fortnox&connect=connected')
    mockFeed.mockReturnValue(feed({ status: null, loading: true }))
    const { unmount } = renderPage()
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/settings?provider=fortnox&connect=connected'))
    unmount()
    mockReplace.mockReset()
    mockFeed.mockReturnValue(feed({ status: { hosted: false, flagEnabled: false, liveSyncReady: false, available: false, connected: false, syncs: [] } }))
    renderPage()
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/settings?provider=fortnox&connect=connected'))
  })

  it('does not touch the URL without an outcome', () => {
    renderPage()
    expect(mockReplace).not.toHaveBeenCalled()
  })
})
