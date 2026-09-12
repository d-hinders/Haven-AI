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
vi.mock('@/hooks/useAccountingFeed', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useAccountingFeed')>('@/hooks/useAccountingFeed')
  return { ...actual, useAccountingFeed: () => mockFeed() }
})
// `ComingSoon` lists the registry's providers; the page tests only care that
// the state renders, so the provider listing is stubbed to a fixed answer.
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn().mockResolvedValue({ providers: [{ id: 'fortnox', displayName: 'Fortnox' }] }) },
  }
})

import AccountingPage from '@/app/(authenticated)/accounting/page'
import { en } from '@/lib/i18n/messages/en'
import { feedStatus } from '@/components/accounting/__tests__/fixtures'
import type { AccountingFeedStatus } from '@/hooks/useAccountingFeed'

function feed(overrides: Record<string, unknown> = {}) {
  return {
    status: feedStatus(),
    loading: false,
    error: null,
    refetch: vi.fn(),
    sync: vi.fn(),
    verify: vi.fn(),
    reopen: vi.fn(),
    ...overrides,
  }
}

/** The page in one feed state. */
function withStatus(overrides: Partial<AccountingFeedStatus>) {
  mockFeed.mockReturnValue(feed({ status: feedStatus(overrides) }))
}

const OFF_COMING_SOON: Partial<AccountingFeedStatus> = {
  enabled: false, flagEnabled: false, available: false, entitled: false, connected: false,
  companyName: null, destination: null, liveSyncReady: false,
}
const OFF_SELF_HOSTED: Partial<AccountingFeedStatus> = { ...OFF_COMING_SOON, hosted: false }

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
    withStatus(OFF_SELF_HOSTED)
    renderPage()
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/settings?provider=fortnox&connect=connected'))
  })

  it('does not touch the URL without an outcome', () => {
    renderPage()
    expect(mockReplace).not.toHaveBeenCalled()
  })
})

/**
 * The two OFF states, on the page (#2869). The owner decision is that they
 * read differently: `hosted && !enabled` is Coming soon, `!hosted` says the
 * feed is not available on a self-hosted box and must never suggest it is
 * on the way. Neither reaches a connect or a sync control.
 */
describe('/accounting off states (#2869)', () => {
  beforeEach(() => {
    mockReplace.mockReset()
    searchParamsRef.current = new URLSearchParams()
    mockFeed.mockReturnValue(feed())
  })

  /** Asserted by ROLE: a disabled control is still reachable and still wrong here. */
  function expectNoFeedControls() {
    for (const name of [/sync now/i, /^connect$/i, /reconnect/i, /check in fortnox/i, /re-open/i]) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
  }

  it('hosted with the flag off: the explanatory Coming soon state, no connect or sync control', async () => {
    withStatus(OFF_COMING_SOON)
    renderPage()
    expect(await screen.findByTestId('accounting-coming-soon')).toBeInTheDocument()
    expect(screen.getByText(en.accountingPage.comingSoon.title)).toBeInTheDocument()
    expect(screen.getByText(en.accountingPage.comingSoon.body)).toBeInTheDocument()
    expectNoFeedControls()
    // The add-on upsell it replaced is gone.
    expect(screen.queryByText(/Available as an add-on/)).toBeNull()
    expect(screen.queryByTestId('accounting-self-hosted')).toBeNull()
  })

  it('self-hosted: the not-available copy renders and NEVER the coming-soon string', () => {
    withStatus(OFF_SELF_HOSTED)
    renderPage()
    expect(screen.getByTestId('accounting-self-hosted')).toBeInTheDocument()
    expect(screen.getByText(en.accountingPage.selfHosted.title)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain(en.common.comingSoon)
    expect(document.body.textContent).not.toContain(en.accountingPage.comingSoon.title)
    expect(screen.queryByTestId('accounting-coming-soon')).toBeNull()
    expectNoFeedControls()
  })

  /**
   * #2869 design review: the product subtitle ("…appears in your accounting
   * tool as draft transactions") asserted something directly above "Nothing
   * can be connected yet." Both off states — and the loading render — get
   * the neutral line; the product sentence is for the feed that is on.
   */
  it.each([
    ['coming soon', OFF_COMING_SOON],
    ['self-hosted', OFF_SELF_HOSTED],
  ])('%s: the header carries the neutral subtitle, never the product sentence', (_name, overrides) => {
    withStatus(overrides)
    renderPage()
    expect(screen.getByText(en.accountingPage.subtitleOff)).toBeInTheDocument()
    expect(screen.queryByText(en.accountingPage.subtitle)).toBeNull()
  })

  it('while the status loads, the header is neutral too — the product sentence is earned by the answer', () => {
    mockFeed.mockReturnValue(feed({ status: null, loading: true }))
    renderPage()
    expect(screen.getByText(en.accountingPage.subtitleOff)).toBeInTheDocument()
    expect(screen.queryByText(en.accountingPage.subtitle)).toBeNull()
  })

  it('self-hosted wins over a set flag — hosted is the outer question', () => {
    withStatus({ ...OFF_SELF_HOSTED, enabled: true, flagEnabled: true })
    renderPage()
    expect(screen.getByTestId('accounting-self-hosted')).toBeInTheDocument()
    expect(screen.queryByTestId('accounting-coming-soon')).toBeNull()
  })

  it('flag on but not entitled: the add-on card, not either off state', () => {
    withStatus({ available: false, entitled: false, connected: false, destination: null, companyName: null })
    renderPage()
    expect(screen.getByText(/Available as an add-on/)).toBeInTheDocument()
    expect(screen.queryByTestId('accounting-coming-soon')).toBeNull()
    expect(screen.queryByTestId('accounting-self-hosted')).toBeNull()
  })
})

/** The flag-on page: the summary line, the feed and the retry counts (#2869). */
describe('/accounting with the feed on (#2869)', () => {
  beforeEach(() => {
    mockReplace.mockReset()
    searchParamsRef.current = new URLSearchParams()
    mockFeed.mockReturnValue(feed())
  })

  it('shows the connection summary line above the feed', () => {
    renderPage()
    const summary = screen.getByTestId('feed-summary')
    expect(summary).toHaveAttribute('data-status', 'connected')
    expect(summary.textContent).toContain('Feeding Fortnox')
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeInTheDocument()
    // The feed that is on earns the product sentence (#2869 design review).
    expect(screen.getByText(en.accountingPage.subtitle)).toBeInTheDocument()
    expect(screen.queryByText(en.accountingPage.subtitleOff)).toBeNull()
  })

  it('"Sync now" is wrapped so it stays content-width in the stacked mobile header (#2869 design review)', () => {
    renderPage()
    const button = screen.getByRole('button', { name: 'Sync now' })
    // A direct child of the `flex-col` header stretches full-width below `sm`;
    // the wrapper is what keeps it the same width as the page's other actions.
    expect(button.parentElement?.className).toContain('shrink-0')
    expect(button.parentElement?.parentElement?.className).toContain('flex-col')
  })

  it('the summary carries the attention state and its way to Settings', () => {
    withStatus({
      connected: false,
      destination: { provider: 'fortnox', displayName: 'Fortnox', status: 'needs_reauthorisation', companyName: null, lastPushAt: null },
    })
    renderPage()
    expect(screen.getByTestId('feed-summary')).toHaveAttribute('data-status', 'needs_reauthorisation')
    expect(screen.getByRole('link', { name: en.accountingPage.summary.fixInSettings })).toHaveAttribute('href', '/settings')
  })

  it('renders the retry counts from the status (#2866), with the exhausted explanation INLINE', () => {
    withStatus({ counts: { pending: 2, failed: 3, exhausted: 1 } })
    renderPage()
    expect(screen.getByTestId('feed-count-pending')).toHaveTextContent('2')
    expect(screen.getByTestId('feed-count-failed')).toHaveTextContent('3')
    expect(screen.getByTestId('feed-count-exhausted')).toHaveTextContent('1')
    // #2869 design review: a `title` is unreachable on touch and to a screen
    // reader — the sentence is rendered, and nothing in the row hides in a title.
    expect(screen.getByTestId('feed-counts-exhausted-help')).toHaveTextContent(en.accountingPage.counts.exhaustedHelp)
    expect(screen.getByTestId('feed-counts').querySelector('[title]')).toBeNull()
  })

  it('the exhausted explanation is absent while nothing has exhausted', () => {
    withStatus({ counts: { pending: 2, failed: 3, exhausted: 0 } })
    renderPage()
    expect(screen.getByTestId('feed-counts')).toBeInTheDocument()
    expect(screen.queryByTestId('feed-counts-exhausted-help')).toBeNull()
    expect(screen.queryByText(en.accountingPage.counts.exhaustedHelp)).toBeNull()
  })

  it('hides the counts row when every count is zero and nothing is listed — three zeros over an empty list say nothing', () => {
    withStatus({ counts: { pending: 0, failed: 0, exhausted: 0 }, syncs: [] })
    renderPage()
    expect(screen.queryByTestId('feed-counts')).toBeNull()
    expect(screen.getByText(/Nothing synced yet/)).toBeInTheDocument()
  })

  it('keeps the counts row when the counts are zero but rows are listed', () => {
    withStatus({
      counts: { pending: 0, failed: 0, exhausted: 0 },
      syncs: [{
        id: 's1', user_id: 'u1', provider: 'fortnox', payment_id: 'pay_1', external_ref: 'fortnox:supplierinvoice:7',
        status: 'pushed', error: null, attempts: 1, created_at: '2026-09-12T09:00:00.000Z', updated_at: '2026-09-12T09:00:00.000Z',
      }],
    })
    renderPage()
    expect(screen.getByTestId('feed-counts')).toBeInTheDocument()
  })
})
