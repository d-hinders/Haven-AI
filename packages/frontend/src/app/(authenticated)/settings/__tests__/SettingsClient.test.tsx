import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '@/context/LocaleContext'

const mockUseAuth = vi.fn()
const mockUsePreferences = vi.fn()
const mockPush = vi.fn()
const mockReplace = vi.fn()

// The Accounting card (#2868) runs its REAL hooks here; only the API client
// is mocked, so the Settings page is exercised end to end from the wire shape.
const { mockApi, searchParamsRef } = vi.hoisted(() => ({
  mockApi: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  searchParamsRef: { current: new URLSearchParams() },
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ApiRequestError: actual.ApiRequestError, api: mockApi }
})

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
  }),
  useSearchParams: () => searchParamsRef.current,
}))
vi.mock('@/hooks/useScrollEdgeCue', () => ({ useScrollEdgeCue: () => false }))

const FORTNOX = {
  id: 'fortnox', displayName: 'Fortnox', authKind: 'oauth2', availability: 'live', configured: true,
  capabilities: { attachments: true, verify: true, revoke: true, companyInfo: true },
  requiredScopes: ['bookkeeping', 'companyinformation', 'archive'],
}
const COMING_SOON = ['Accounted', 'Light', 'Igdrasil'].map((displayName) => ({
  ...FORTNOX, id: displayName.toLowerCase(), displayName, availability: 'coming_soon', configured: false, requiredScopes: [],
}))
const CONNECTED = {
  provider: 'fortnox', displayName: 'Fortnox', authKind: 'oauth2', status: 'connected', statusReason: null,
  isActiveDestination: true, feedFrom: '2026-09-01T08:00:00.000Z', grantedScope: 'bookkeeping companyinformation archive',
  missingScopes: [], tokenExpiresAt: '2026-09-12T08:00:00.000Z', externalCompanyId: '1234567',
  externalCompanyName: 'Ada Lovelace AB', baseCurrency: 'SEK', lastPushAt: '2026-09-10T14:30:00.000Z', lastError: null,
  connectedAt: '2026-09-01T08:00:00.000Z', updatedAt: '2026-09-10T14:30:00.000Z',
  settings: { suggestedAccount: null, autoFeed: true },
}

/**
 * The card reads the feed status too (#2869) and FAILS CLOSED without it —
 * a failed read renders no controls — so the ON answer is served here. The
 * shape is `components/accounting/__tests__/fixtures.ts`'s `feedStatus()`.
 */
const FEED_ON = {
  hosted: true, enabled: true, flagEnabled: true, liveSyncReady: true, entitled: true, entitlementMode: 'all',
  available: true, connected: true, companyName: 'Ada Lovelace AB',
  destination: { provider: 'fortnox', displayName: 'Fortnox', status: 'connected', companyName: 'Ada Lovelace AB', lastPushAt: '2026-09-10T14:30:00.000Z' },
  missingScopes: [], syncs: [], counts: { pending: 0, failed: 0, exhausted: 0 },
}

function serveAccounting(connections: unknown[]) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/accounting/providers') return Promise.resolve({ providers: [FORTNOX, ...COMING_SOON] })
    if (url === '/accounting/connections') return Promise.resolve({ connections })
    if (url === '/accounting/feed/status') return Promise.resolve(FEED_ON)
    return Promise.reject(new Error(`unexpected GET ${url}`))
  })
}

vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => mockUsePreferences(),
}))

import SettingsClient from '@/app/(authenticated)/settings/SettingsClient'

function renderSettings() {
  return render(
    <LocaleProvider>
      <SettingsClient />
    </LocaleProvider>,
  )
}

describe('SettingsClient', () => {
  beforeEach(() => {
    mockUseAuth.mockReset()
    mockUsePreferences.mockReset()
    mockPush.mockReset()
    mockReplace.mockReset()
    mockApi.get.mockReset()
    mockApi.post.mockReset()
    mockApi.patch.mockReset()
    mockApi.delete.mockReset()
    searchParamsRef.current = new URLSearchParams()
    serveAccounting([CONNECTED])
    window.localStorage.clear()

    mockUsePreferences.mockReturnValue({
      currency: 'USD',
      setCurrency: vi.fn(),
      saving: false,
    })
    mockUseAuth.mockReturnValue({
      user: { name: null, email: 'passkey@example.com', wallet_address: null, safes: [] },
      passkeys: [],
      logout: vi.fn(),
      updateUser: vi.fn(),
    })
  })

  it('renders the Access and Recovery sections for a passkey-managed account', () => {
    renderSettings()

    expect(screen.getByText('Access')).toBeInTheDocument()
    expect(screen.getByText('Passkey status')).toBeInTheDocument()
    expect(screen.getByText('Recovery and safety')).toBeInTheDocument()
  })

  /**
   * #1989 (epic #1440): the Approvers section is deleted. It hosted
   * `ManageApprovers`, whose only backend — the five approver routes — #1988
   * removed. A section every action of which 404s is worse than no section.
   *
   * Asserted with a positive control first, so "no Approvers section" cannot
   * be satisfied by the settings page failing to render at all.
   */
  it('offers no Approvers section', () => {
    renderSettings()

    expect(screen.getByText('Recovery and safety')).toBeInTheDocument()
    expect(screen.queryByText('Approvers')).toBeNull()
    expect(screen.queryByText('Manage approvers component')).toBeNull()
  })

  it('links profile management to the profile page', () => {
    renderSettings()

    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View profile' })).toHaveAttribute('href', '/profile')
  })

  /**
   * #2926: the language row is gone with the Swedish catalog. Asserted as an
   * absence on the rendered page rather than deleted silently, so re-adding a
   * language control is a deliberate act that turns this red.
   */
  it('offers no language control — Preferences is currency and alerts only', () => {
    renderSettings()

    expect(screen.getByText('Preferred currency')).toBeInTheDocument()
    expect(screen.queryByText('Language')).toBeNull()
    expect(screen.queryByRole('radio', { name: 'Svenska' })).toBeNull()
    expect(screen.queryByRole('radio', { name: 'English' })).toBeNull()
    const currency = screen.getByRole('radiogroup', { name: 'Preferred currency' })
    expect(screen.getAllByRole('radiogroup')).toEqual([currency])
  })

  /**
   * #2868 (epic #2858): the Accounting connections card lives in Settings —
   * owner decision 2026-09-11. Pinned here at the page, not only in the
   * card's own suite, so the section cannot silently drop out of the list.
   */
  describe('Accounting connections (#2868)', () => {
    it('renders the Accounting section between Access and Recovery with every provider', async () => {
      renderSettings()
      expect(await screen.findByText(/Connected to Ada Lovelace AB/)).toBeInTheDocument()
      const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
      expect(headings.indexOf('Accounting')).toBeGreaterThan(headings.indexOf('Access'))
      expect(headings.indexOf('Accounting')).toBeLessThan(headings.indexOf('Recovery and safety'))
      for (const p of COMING_SOON) {
        expect(within(screen.getByTestId(`connection-row-${p.id}`)).getByText('Coming soon')).toBeInTheDocument()
      }
      expect(mockApi.get).toHaveBeenCalledWith('/accounting/providers')
      expect(mockApi.get).toHaveBeenCalledWith('/accounting/connections')
    })

    it('a degraded connection shows Reconnect on the Settings page', async () => {
      serveAccounting([{ ...CONNECTED, status: 'needs_reauthorisation' }])
      renderSettings()
      const slot = await screen.findByTestId('connection-actions-fortnox')
      expect(within(slot).getByRole('button', { name: 'Reconnect' })).toBeInTheDocument()
      expect(screen.getByText('Sign-in expired')).toBeInTheDocument()
    })

    it('the OAuth return (?provider=fortnox&connect=connected) on a first connect opens the backfill choice here', async () => {
      searchParamsRef.current = new URLSearchParams('provider=fortnox&connect=connected')
      serveAccounting([{ ...CONNECTED, lastPushAt: null }])
      renderSettings()
      expect(await screen.findByRole('dialog')).toHaveTextContent('Include earlier payments?')
      expect(mockReplace).toHaveBeenCalledWith('/settings')
    })
  })
})
