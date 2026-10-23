import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '@/context/LocaleContext'
import { ThemeProvider } from '@/context/ThemeContext'
import { THEME_STORAGE_KEY } from '@/lib/theme-bootstrap'

const mockUseAuth = vi.fn()
const mockUsePreferences = vi.fn()
const mockPush = vi.fn()
const mockReplace = vi.fn()

// The Accounting card (#2868) runs its REAL hooks here; only the API client
// is mocked, so the Settings page is exercised end to end from the wire shape.
const { mockApi, searchParamsRef } = vi.hoisted(() => ({
  mockApi: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
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
// #3825: the Signers section's wallet-connection row reads wagmi and
// RainbowKit, which this page test does not provide.
vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: false, address: undefined, connector: undefined }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
}))
vi.mock('@rainbow-me/rainbowkit', () => ({ useConnectModal: () => ({ openConnectModal: vi.fn() }) }))

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

/** One passkey approving two accounts and one wallet approving one (#4358). */
const SIGNERS = [
  {
    kind: 'passkey' as const,
    key_id: 'key-1',
    created_at: '2026-10-16T08:00:00.000Z',
    accounts: [
      { account_id: 'acc-1', account_address: '0x1', account_name: 'Operations', chain_id: 8453 },
      { account_id: 'acc-2', account_address: '0x2', account_name: null, chain_id: 84532 },
    ],
  },
  {
    kind: 'wallet' as const,
    address: '0xabc',
    accounts: [{ account_id: 'acc-3', account_address: '0x3', account_name: 'Treasury', chain_id: 8453 }],
  },
]

function serveAccounting(connections: unknown[]) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/accounting/providers') return Promise.resolve({ providers: [FORTNOX, ...COMING_SOON] })
    if (url === '/accounting/connections') return Promise.resolve({ connections })
    if (url === '/accounting/feed/status') return Promise.resolve(FEED_ON)
    // #3825: the Signers section reads every signer once.
    if (url === '/user/signers') return Promise.resolve({ signers: SIGNERS })
    return Promise.reject(new Error(`unexpected GET ${url}`))
  })
}

vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => mockUsePreferences(),
}))

import SettingsClient from '@/app/(authenticated)/settings/SettingsClient'
import { ConnectOutcomeForwarder } from '@/components/accounting/ConnectOutcomeForwarder'

function renderSettings() {
  // #main-content is the shell's own landmark (`AuthenticatedShell`); the
  // "no Coming soon" assertions are scoped to it because the SIDEBAR's
  // Accounting pill legitimately carries `common.comingSoon` — and the
  // sidebar is not rendered here, the wrapper is what stands in for it.
  return render(
    <div id="main-content">
      <LocaleProvider>
        <ThemeProvider>
          <SettingsClient />
        </ThemeProvider>
      </LocaleProvider>
    </div>,
  )
}

function setTabParam(tab: string | null) {
  const params = new URLSearchParams()
  if (tab) params.set('tab', tab)
  searchParamsRef.current = params
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
    mockApi.put.mockReset()
    mockApi.delete.mockReset()
    searchParamsRef.current = new URLSearchParams()
    serveAccounting([CONNECTED])
    window.localStorage.clear()
    window.location.hash = ''

    mockUsePreferences.mockReturnValue({
      currency: 'USD',
      setCurrency: vi.fn(),
      saving: false,
    })
    mockUseAuth.mockReturnValue({
      user: {
        name: 'Ada Lovelace',
        email: 'passkey@example.com',
        wallet_address: null,
        accounts: [],
        created_at: '2025-01-15T12:00:00.000Z',
      },
      passkeys: [],
      logout: vi.fn(),
      updateUser: vi.fn(),
    })
  })

  it('renders the General, Security and Business tabs, General first', () => {
    renderSettings()

    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Security' })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tab', { name: 'Business' })).toHaveAttribute('aria-selected', 'false')
    // General content, not Business content.
    expect(screen.getByRole('heading', { name: 'Profile' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Accounting' })).toBeNull()
  })

  it('reads the tab from ?tab= so it survives a reload', () => {
    setTabParam('security')
    renderSettings()

    expect(screen.getByRole('tab', { name: 'Security' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { name: 'Passkeys and wallets' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Profile' })).toBeNull()
  })

  it('falls back to General for an unknown tab value', () => {
    setTabParam('nonsense')
    renderSettings()

    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { name: 'Profile' })).toBeInTheDocument()
  })

  // The tab row must add no history entry: switching replaces, never
  // pushes, so Back leaves Settings entirely rather than walking the tabs.
  it('switches tabs with router.replace and no history entry', () => {
    const view = renderSettings()

    fireEvent.click(screen.getByRole('tab', { name: 'Security' }))
    expect(mockReplace).toHaveBeenCalledWith('/settings?tab=security', { scroll: false })
    expect(mockPush).not.toHaveBeenCalled()
    // The router owns the URL from here: in the real app the replace
    // re-renders the page with the new `useSearchParams`; the mocked router
    // needs the same beat spelled out.
    mockReplace.mockClear()
    setTabParam('security')
    view.rerender(
      <div id="main-content">
        <LocaleProvider>
          <ThemeProvider>
            <SettingsClient />
          </ThemeProvider>
        </LocaleProvider>
      </div>,
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Business' }))
    expect(mockReplace).toHaveBeenCalledWith('/settings?tab=business', { scroll: false })

    // The default tab is the canonical address: no `?tab=` in the URL.
    mockReplace.mockClear()
    setTabParam('business')
    view.rerender(
      <div id="main-content">
        <LocaleProvider>
          <ThemeProvider>
            <SettingsClient />
          </ThemeProvider>
        </LocaleProvider>
      </div>,
    )
    fireEvent.click(screen.getByRole('tab', { name: 'General' }))
    expect(mockReplace).toHaveBeenCalledWith('/settings', { scroll: false })
  })

  it('keeps the OAuth outcome parameters in the URL while switching tabs', () => {
    searchParamsRef.current = new URLSearchParams('provider=fortnox&connect=connected')
    renderSettings()

    // No explicit ?tab=, but outcome params are present: Business is
    // selected (the old bookmarked callback still lands right).
    expect(screen.getByRole('tab', { name: 'Business' })).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(screen.getByRole('tab', { name: 'General' }))
    expect(mockReplace).toHaveBeenCalledWith('/settings?provider=fortnox&connect=connected', { scroll: false })
  })

  describe('General → Profile', () => {
    it('shows the name with its editor, the read-only email and Member since', async () => {
      const user = userEvent.setup()
      renderSettings()

      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
      expect(screen.getByText('passkey@example.com')).toBeInTheDocument()
      // The repo's shared en-GB long date (the old /profile page used en-US).
      expect(screen.getByText('15 January 2025')).toBeInTheDocument()

      mockApi.put.mockResolvedValue({ name: 'Grace Hopper' })
      await user.click(screen.getByRole('button', { name: 'Edit' }))
      await user.clear(screen.getByLabelText('Name'))
      await user.type(screen.getByLabelText('Name'), ' Grace   Hopper ')
      await user.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() => {
        expect(mockApi.put).toHaveBeenCalledWith('/user/profile', { name: 'Grace Hopper' })
      })
      await waitFor(() => expect(screen.getByText('Name updated.')).toBeInTheDocument())
    })
  })

  describe('General → Your data', () => {
    it('links Export transactions to /transactions, where the CSV lives', () => {
      renderSettings()

      expect(screen.getByRole('heading', { name: 'Your data' })).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Open Transactions' })).toHaveAttribute('href', '/transactions')
    })
  })

  describe('Security', () => {
    it('anchors Passkeys and wallets at #signers, before If something goes wrong', () => {
      setTabParam('security')
      renderSettings()
      expect(document.getElementById('signers')).not.toBeNull()
      const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
      expect(headings.indexOf('Passkeys and wallets')).toBeGreaterThan(-1)
      expect(headings.indexOf('If something goes wrong')).toBeGreaterThan(headings.indexOf('Passkeys and wallets'))
    })

    it('renders each approved account as a link to its ?tab=security', async () => {
      setTabParam('security')
      renderSettings()

      const operations = await screen.findByRole('link', { name: 'Operations (Base)' })
      expect(operations).toHaveAttribute('href', '/accounts/acc-1?tab=security')
      // A null account name falls back to the shared fallback label.
      expect(screen.getByRole('link', { name: 'Account (Base Sepolia)' })).toHaveAttribute(
        'href',
        '/accounts/acc-2?tab=security',
      )
      expect(screen.getByRole('link', { name: 'Treasury (Base)' })).toHaveAttribute(
        'href',
        '/accounts/acc-3?tab=security',
      )
    })

    it('offers the exit path and what Haven cannot recover, with the backup line', () => {
      setTabParam('security')
      renderSettings()

      expect(screen.getByText("What Haven can't recover")).toBeInTheDocument()
      expect(
        screen.getByText(/Keep a backup passkey or wallet on each funded account\./),
      ).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Your exit path' })).toHaveAttribute('href', '/exit/')
    })
  })

  describe('Business', () => {
    it('moves the Accounting connections and company details here unchanged', async () => {
      setTabParam('business')
      renderSettings()
      expect(await screen.findByText(/Connected to Ada Lovelace AB/)).toBeInTheDocument()
      expect(mockApi.get).toHaveBeenCalledWith('/accounting/providers')
      expect(mockApi.get).toHaveBeenCalledWith('/accounting/connections')
    })

    it('the OAuth return (?provider=fortnox&connect=connected) on a first connect opens the backfill choice here', async () => {
      searchParamsRef.current = new URLSearchParams('provider=fortnox&connect=connected&tab=business')
      serveAccounting([{ ...CONNECTED, lastPushAt: null }])
      renderSettings()
      expect(await screen.findByRole('dialog')).toHaveTextContent('Include earlier payments?')
      // The card strips ONLY the outcome parameters — `tab` survives.
      expect(mockReplace).toHaveBeenCalledWith('/settings?tab=business')
    })

    /**
     * The forwarder's REAL output (#4358 spec review): the accounting page
     * must land the callback on the Business tab WITH the outcome
     * parameters — built with `URLSearchParams`, `tab=business` joined
     * alongside, never appended to a constant already holding `?tab=…`.
     * Retargeting this by mocking the forwarder would pass while the bug
     * stayed.
     */
    it('the accounting page forwards the callback to /settings?…&tab=business', async () => {
      searchParamsRef.current = new URLSearchParams('provider=fortnox&connect=connected')
      render(
        <LocaleProvider>
          <ConnectOutcomeForwarder />
        </LocaleProvider>,
      )
      await waitFor(() => {
        expect(mockReplace).toHaveBeenCalledWith('/settings?provider=fortnox&connect=connected&tab=business')
      })
    })
  })

  // #3825: Signers replaced the Access → "Passkey status" row and Recovery's
  // "Backup and recovery" placeholder. Positive control: the sections they
  // sat in still render.
  it('no longer carries the Passkey status row or the Backup and recovery placeholder', () => {
    setTabParam('security')
    renderSettings()
    expect(screen.getByText("What Haven can't recover")).toBeInTheDocument()
    expect(screen.queryByText('Passkey status')).toBeNull()
    expect(screen.queryByText('Backup and recovery')).toBeNull()
  })

  /**
   * #1989 (epic #1440): the Approvers section is deleted, and #4358 removes
   * the remaining placeholders with it. Asserted as absences on the rendered
   * page, with positive controls first, so "no X" cannot be satisfied by the
   * page failing to render at all.
   */
  it('offers no removed placeholder sections on General or Security', () => {
    renderSettings()
    // Positive controls on the SAME tab, so the render is live.
    expect(screen.getByRole('heading', { name: 'Profile' })).toBeInTheDocument()
    expect(screen.getByText('Preferred currency')).toBeInTheDocument()
    for (const gone of ['Approvers', 'Manage approvers component', 'Agent spend alerts', 'Password', 'Active sessions', 'Privacy controls']) {
      expect(screen.queryByText(gone)).toBeNull()
    }

    setTabParam('security')
    renderSettings()
    expect(screen.getByRole('heading', { name: 'Passkeys and wallets' })).toBeInTheDocument()
    expect(screen.queryByText('Password')).toBeNull()
  })

  /**
   * #2926: the language row is gone with the Swedish catalog. Re-adding a
   * language control is a deliberate act that turns this red.
   */
  it('offers no language control — Preferences is currency and theme only', () => {
    renderSettings()

    expect(screen.getByText('Preferred currency')).toBeInTheDocument()
    expect(screen.queryByText('Language')).toBeNull()
    expect(screen.queryByRole('radio', { name: 'Svenska' })).toBeNull()
    expect(screen.queryByRole('radio', { name: 'English' })).toBeNull()
    const currency = screen.getByRole('radiogroup', { name: 'Preferred currency' })
    // #2927: the Appearance row joins currency as the second radiogroup.
    const theme = screen.getByRole('radiogroup', { name: 'Theme' })
    expect(screen.getAllByRole('radiogroup')).toEqual([currency, theme])
  })

  /**
   * #4358: no "Coming soon" renders on General or Security. Scoped to
   * #main-content (the sidebar's Accounting pill shares
   * `common.comingSoon`) and anchored on a LIVE row first, so a skeleton
   * cannot pass it trivially.
   */
  describe('no Coming soon on General or Security', () => {
    it('General: anchored on the live currency row', () => {
      renderSettings()
      const main = document.getElementById('main-content')!
      expect(within(main).getByText('Preferred currency')).toBeInTheDocument()
      expect(within(main).queryByText('Coming soon')).toBeNull()
    })

    it('Security: anchored on the loaded signer rows', async () => {
      setTabParam('security')
      renderSettings()
      const main = document.getElementById('main-content')!
      // Live row first: the passkey row only exists once /user/signers answered.
      expect(await within(main).findByText('Passkey · added 16 October 2026')).toBeInTheDocument()
      expect(within(main).queryByText('Coming soon')).toBeNull()
    })
  })

  /**
   * #2927: the Appearance row — a three-way radio group (Light / Dark /
   * System) on the promoted ui/SegmentedControl. Each choice writes
   * `haven.theme` device-local; `system` (the default) writes the key too so
   * a later `system` re-select is explicit rather than absent.
   */
  describe('Appearance (#2927)', () => {
    it('renders the Theme row with the three options and System active by default', () => {
      renderSettings()

      expect(screen.getByText('Theme')).toBeInTheDocument()
      expect(screen.getByText('System follows your device. The toggle in the sidebar changes the same setting.')).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute(
        'aria-checked',
        'true',
      )
      expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'false')
      expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'false')
    })

    it('each choice writes the storage key', async () => {
      renderSettings()

      fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
      await waitFor(() =>
        expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark'),
      )

      fireEvent.click(screen.getByRole('radio', { name: 'Light' }))
      await waitFor(() =>
        expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light'),
      )

      fireEvent.click(screen.getByRole('radio', { name: 'System' }))
      await waitFor(() =>
        expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system'),
      )
    })
  })

  /**
   * #3127: SEK joins the currency radio. It is the currency the backend
   * already served and defaulted to, and the one no user could previously
   * select — a new signup whose `currency_preference` is 'SEK' must find the
   * option on the page AND see it as the active one, not a dead control.
   */
  describe('Preferred currency (#3127)', () => {
    it('offers SEK beside USD and EUR, with the served default active', () => {
      mockUsePreferences.mockReturnValue({ currency: 'SEK', setCurrency: vi.fn(), saving: false })
      renderSettings()

      const currency = screen.getByRole('radiogroup', { name: 'Preferred currency' })
      expect(within(currency).getByRole('radio', { name: '$ USD' })).toHaveAttribute('aria-checked', 'false')
      expect(within(currency).getByRole('radio', { name: '€ EUR' })).toHaveAttribute('aria-checked', 'false')
      expect(within(currency).getByRole('radio', { name: 'kr SEK' })).toHaveAttribute('aria-checked', 'true')
    })

    it('keeps USD active when the preference is USD', () => {
      renderSettings()

      const currency = screen.getByRole('radiogroup', { name: 'Preferred currency' })
      expect(within(currency).getByRole('radio', { name: '$ USD' })).toHaveAttribute('aria-checked', 'true')
      expect(within(currency).getByRole('radio', { name: 'kr SEK' })).toHaveAttribute('aria-checked', 'false')
    })
  })
})
