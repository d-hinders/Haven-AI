import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAuth = vi.fn()
const mockUsePathname = vi.fn()
const mockPush = vi.fn()
/** #2869: the Accounting entry's markers come from `GET /accounting/feed/status`. */
const mockAccountingFeed = vi.fn()

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('@/hooks/useAccountingFeed', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useAccountingFeed')>('@/hooks/useAccountingFeed')
  return { ...actual, useAccountingFeed: () => mockAccountingFeed() }
})


vi.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
  useRouter: () => ({ push: mockPush }),
}))

vi.mock('@/components/ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

import Sidebar from '@/components/sidebar/Sidebar'
import { LocaleProvider } from '@/context/LocaleContext'
import { en } from '@/lib/i18n/messages/en'
import type { AccountingFeedStatus } from '@/hooks/useAccountingFeed'

/** The ready, connected, quiet feed — the state that must show NO marker. */
function feedStatus(overrides: Partial<AccountingFeedStatus> = {}): AccountingFeedStatus {
  return {
    hosted: true,
    enabled: true,
    flagEnabled: true,
    liveSyncReady: true,
    entitled: true,
    entitlementMode: 'all',
    available: true,
    connected: true,
    companyName: 'Ada Lovelace AB',
    destination: {
      provider: 'fortnox',
      displayName: 'Fortnox',
      status: 'connected',
      companyName: 'Ada Lovelace AB',
      lastPushAt: '2026-09-12T09:58:00.000Z',
    },
    missingScopes: [],
    syncs: [],
    counts: { pending: 0, failed: 0, exhausted: 0 },
    ...overrides,
  }
}

function feed(status: AccountingFeedStatus | null) {
  return { status, loading: false, error: null, refetch: vi.fn(), sync: vi.fn(), verify: vi.fn(), reopen: vi.fn() }
}

describe('Sidebar', () => {
  beforeEach(() => {
    mockUseAuth.mockReset()
    mockUsePathname.mockReset()
    mockPush.mockReset()
    mockAccountingFeed.mockReset().mockReturnValue(feed(feedStatus()))

    mockUsePathname.mockReturnValue('/dashboard')
    mockUseAuth.mockReturnValue({
      user: {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        safes: [],
      },
      logout: vi.fn(),
    })
  })

  it('renders three labeled clusters with the core money loop first (#858)', () => {
    render(<LocaleProvider><Sidebar /></LocaleProvider>)
    const labels = ['Money', 'Agent tools', 'Admin'].map((l) => screen.getByText(l))
    expect(labels).toHaveLength(3)
    // Core loop order and routes unchanged (scoped to the nav — the logo also links to /dashboard):
    // Scoped to the DRAWER's landmark by name (#2731). `querySelector('nav')`
    // took the first `<nav>` in the DOM, and the mobile tab bar now renders
    // before this one — the assertion silently started measuring four tab
    // routes instead of the drawer's eight.
    const links = Array.from(
      document.querySelector('nav[aria-label="All sections"]')!.querySelectorAll('a'),
    ).map((a) =>
      a.getAttribute('href'),
    )
    const nav = links.filter((href) =>
      ['/dashboard', '/accounts', '/transactions', '/agents', '/approvals', '/catalog', '/contacts', '/accounting', '/custody'].includes(href ?? ''),
    )
    // '/approvals' stays in the FILTER above deliberately: the filter is what
    // makes this assertion able to see a re-added Approvals entry. Removing it
    // from both sides would turn the equality into a guard over the empty set.
    expect(nav).toEqual([
      '/dashboard', '/accounts', '/transactions', '/agents',
      '/catalog', '/contacts',
      '/accounting', '/custody',
    ])
    // The Money label precedes the Agent tools label in the DOM:
    const money = screen.getByText('Money')
    const tools = screen.getByText('Agent tools')
    expect(money.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // #1989 (epic #1440): the Approvals entry and its live badge are DELETED, for
  // every user — not hidden per-account as #1079 had it. The approval queue was
  // a legacy-rail concept, `POST /approvals/:id/approve` answers 410 (#1986),
  // and the queue UI is gone, so the nav entry could only dead-end.
  //
  // Asserted on a MIXED-rail user, which is the case #1079's old
  // `onlyDelegationAccounts` predicate deliberately kept the entry for. If the
  // entry ever comes back, it comes back here first.
  it('offers no Approvals entry even for a user holding a legacy Safe account', () => {
    mockUseAuth.mockReturnValue({
      user: {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        safes: [
          { id: 's1', account_type: 'safe' },
          { id: 's2', account_type: 'delegator_hybrid' },
        ],
      },
      logout: vi.fn(),
    })
    render(<LocaleProvider><Sidebar /></LocaleProvider>)
    expect(screen.queryByRole('link', { name: /Approvals/ })).toBeNull()
    // Scoped like the assertion above (#2731). This one was the more dangerous
    // of the two: it is a NEGATIVE assertion, so pointing it at the tab bar
    // made it unable to FAIL rather than merely wrong — the four tab routes
    // never contain '/approvals' whatever the drawer does.
    const hrefs = Array.from(
      document.querySelector('nav[aria-label="All sections"]')!.querySelectorAll('a'),
    ).map((a) =>
      a.getAttribute('href'),
    )
    expect(hrefs).not.toContain('/approvals')
  })

  /**
   * The Accounting entry's three feed states (#2869).
   *
   * The badge is an ATTENTION marker, not a count: it appears when the feed
   * destination needs a reconnect (`needs_reauthorisation`, `scope_missing`,
   * `revoked_at_provider`) or when the retry sweep has given up on a row
   * (`counts.exhausted > 0`), and it is absent otherwise. Each case asserts
   * the entry is still there, so an assertion cannot pass because the whole
   * item vanished.
   */
  describe('Accounting entry, by feed state (#2869)', () => {
    const accountingLink = () =>
      document.querySelector('nav[aria-label="All sections"] a[href="/accounting"]') as HTMLElement | null
    const attentionDot = () => screen.queryByTestId('nav-attention-accounting')

    it('quiet feed: the entry renders with NO badge and NO attention dot', () => {
      render(<LocaleProvider><Sidebar /></LocaleProvider>)
      expect(accountingLink()).not.toBeNull()
      expect(attentionDot()).toBeNull()
      expect(accountingLink()!.textContent).not.toContain(en.accountingPage.nav.comingSoon)
    })

    it.each([
      ['needs_reauthorisation' as const],
      ['scope_missing' as const],
      ['revoked_at_provider' as const],
    ])('destination %s: the attention dot appears', (status) => {
      mockAccountingFeed.mockReturnValue(
        feed(feedStatus({ destination: { provider: 'fortnox', displayName: 'Fortnox', status, companyName: null, lastPushAt: null } })),
      )
      render(<LocaleProvider><Sidebar /></LocaleProvider>)
      expect(accountingLink()).not.toBeNull()
      expect(attentionDot()).not.toBeNull()
      expect(attentionDot()!.textContent).toContain(en.accountingPage.nav.attention)
    })

    it('an exhausted sync raises the dot even on a healthy connection (#2866)', () => {
      mockAccountingFeed.mockReturnValue(feed(feedStatus({ counts: { pending: 0, failed: 3, exhausted: 1 } })))
      render(<LocaleProvider><Sidebar /></LocaleProvider>)
      expect(attentionDot()).not.toBeNull()
    })

    it('retryable failures alone do NOT raise it — the sweep owns those', () => {
      mockAccountingFeed.mockReturnValue(feed(feedStatus({ counts: { pending: 2, failed: 5, exhausted: 0 } })))
      render(<LocaleProvider><Sidebar /></LocaleProvider>)
      expect(attentionDot()).toBeNull()
    })

    it('hosted with the flag off: the entry stays, carrying a Coming soon marker and no dot', () => {
      mockAccountingFeed.mockReturnValue(
        feed(feedStatus({ enabled: false, flagEnabled: false, available: false, entitled: false, connected: false, destination: null })),
      )
      render(<LocaleProvider><Sidebar /></LocaleProvider>)
      expect(accountingLink()).not.toBeNull()
      expect(accountingLink()!.textContent).toContain(en.accountingPage.nav.comingSoon)
      // The abbreviated pill carries the full phrase as its title.
      expect(accountingLink()!.querySelector(`[title="${en.common.comingSoon}"]`)).not.toBeNull()
      expect(attentionDot()).toBeNull()
    })

    it('self-hosted: the entry is hidden, and never marked Coming soon', () => {
      mockAccountingFeed.mockReturnValue(
        feed(feedStatus({ hosted: false, enabled: false, flagEnabled: false, available: false, entitled: false, connected: false, destination: null })),
      )
      render(<LocaleProvider><Sidebar /></LocaleProvider>)
      expect(accountingLink()).toBeNull()
      // Positive control: the rest of the Admin cluster is untouched.
      expect(document.querySelector('nav[aria-label="All sections"] a[href="/custody"]')).not.toBeNull()
      const navText = document.querySelector('nav[aria-label="All sections"]')!.textContent ?? ''
      expect(navText).not.toContain(en.common.comingSoon)
      expect(navText).not.toContain(en.accountingPage.nav.comingSoon)
    })

    it('before the status answers: the entry renders plain, with no marker it has not earned', () => {
      mockAccountingFeed.mockReturnValue({ ...feed(null), loading: true })
      render(<LocaleProvider><Sidebar /></LocaleProvider>)
      expect(accountingLink()).not.toBeNull()
      expect(attentionDot()).toBeNull()
      expect(accountingLink()!.textContent).not.toContain(en.accountingPage.nav.comingSoon)
    })
  })

  it('opens profile from the bottom-left identity area', () => {
    render(<LocaleProvider><Sidebar /></LocaleProvider>)

    const profileLink = screen.getByRole('link', { name: 'Open profile for Ada Lovelace' })
    expect(profileLink).toHaveAttribute('href', '/profile')
  })

  it('shows Profile, Settings, and sign out in the account menu', async () => {
    const user = userEvent.setup()
    const logout = vi.fn()
    mockUseAuth.mockReturnValue({
      user: {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        safes: [],
      },
      logout,
    })
    render(<LocaleProvider><Sidebar /></LocaleProvider>)

    await user.click(screen.getByRole('button', { name: 'User menu' }))

    expect(screen.getByRole('menuitem', { name: 'Profile' })).toHaveAttribute('href', '/profile')
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute('href', '/settings')
    await user.click(screen.getByRole('menuitem', { name: 'Log out' }))

    expect(logout).toHaveBeenCalled()
    expect(mockPush).toHaveBeenCalledWith('/')
  })
})

/**
 * The drawer must not sit on top of the page after the viewport narrows (#2586).
 *
 * jsdom has no layout, so this asserts the ONE class that decides it:
 * `-translate-x-full` is the only thing keeping a `fixed inset-y-0 left-0`
 * drawer off screen below `lg`. Without it the drawer paints over the page —
 * the reported symptom, where the sidebar's footer row obscures the left edge
 * of the `/agents` empty state's prompt card and clips its footer link.
 *
 * Driven through `matchMedia` rather than `window.innerWidth` + a `resize`
 * event, because that is what the component listens to; a test that fired
 * `resize` would pass against an implementation that handles neither.
 */
describe('Sidebar drawer across the desktop breakpoint (#2586)', () => {
  /*
    The mock has to be as strict as the real API, or the tests below are
    theatre — measured, not supposed. An earlier version discarded the query
    string and the event type, and TWO mutations that break the product
    completely stayed 7/7 green (review finding): inverting the query to
    `min-width` (which un-collapses the drawer at every mobile width) and
    registering the listener under a bogus event type (which makes the fix do
    nothing). Neither is visible to a mock that fans every call out to every
    listener regardless of what it was asked for.

    So: the query string is asserted against the ONE query this component may
    ask, `matches` is derived live from the current width rather than
    snapshotted, and `change` is the only type that registers a listener.
  */
  const DESKTOP_QUERY = '(min-width: 1024px)'
  const listeners = new Set<(e: MediaQueryListEvent) => void>()
  let width = 1280

  const installMatchMedia = () => {
    listeners.clear()
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string) => {
        // Not a soft assertion: a component asking a different question is a
        // component this suite is not testing, and silently answering it is
        // how the two mutations above passed.
        expect(query, 'Sidebar asked matchMedia a query this mock does not model').toBe(
          DESKTOP_QUERY,
        )
        return {
          // A getter, so it tracks `width` the way a real MediaQueryList
          // tracks the viewport instead of freezing at construction.
          get matches() {
            return width >= 1024
          },
          media: query,
          onchange: null,
          addEventListener: (type: string, fn: (e: MediaQueryListEvent) => void) => {
            if (type === 'change') listeners.add(fn)
          },
          removeEventListener: (type: string, fn: (e: MediaQueryListEvent) => void) => {
            if (type === 'change') listeners.delete(fn)
          },
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }
      },
    })
  }

  /** Move the viewport and fire `change` exactly as a browser would. */
  const setWidth = (next: number) => {
    width = next
    Object.defineProperty(window, 'innerWidth', {
      value: next,
      writable: true,
      configurable: true,
    })
    act(() => {
      for (const fn of listeners) fn({ matches: next >= 1024 } as MediaQueryListEvent)
    })
  }

  const crossTo = (isMobile: boolean) => setWidth(isMobile ? 390 : 1280)

  const drawer = () => document.querySelector('aside') as HTMLElement
  const offScreen = () => drawer().className.includes('-translate-x-full')

  beforeEach(() => {
    mockUsePathname.mockReturnValue('/dashboard')
    mockUseAuth.mockReturnValue({
      user: { name: 'Ada Lovelace', email: 'ada@example.com', safes: [] },
      logout: vi.fn(),
    })
    mockAccountingFeed.mockReset().mockReturnValue(feed(feedStatus()))
    width = 1280
    installMatchMedia()
  })

  it('collapses when the viewport narrows past the breakpoint', () => {
    width = 1280
    Object.defineProperty(window, 'innerWidth', { value: 1280, writable: true, configurable: true })
    render(<LocaleProvider><Sidebar /></LocaleProvider>)

    // Mounted at desktop width: on screen, which is correct — at `lg` the
    // drawer is `static` and `collapsed` does not hide it.
    expect(offScreen()).toBe(false)

    crossTo(true)

    // The regression. Before #2586 this stayed false, and the drawer painted
    // over the page at every width below `lg`.
    expect(offScreen()).toBe(true)
  })

  it('POSITIVE CONTROL: a fresh mount at mobile width was already collapsed', () => {
    // Without this, the assertion above could pass against a component that
    // collapses unconditionally — and it pins why no visual baseline could
    // have caught the defect, since the capture harness sets the viewport
    // before it navigates and therefore only ever exercises this path.
    width = 390
    Object.defineProperty(window, 'innerWidth', { value: 390, writable: true, configurable: true })
    render(<LocaleProvider><Sidebar /></LocaleProvider>)
    expect(offScreen()).toBe(true)
  })

  it('syncs on mount when the initialiser and the media query disagree', () => {
    // The initialiser runs during RENDER and reads `window.innerWidth`, which
    // is `undefined` on the server — so a server-rendered page reaches a phone
    // with `collapsed = false` no matter how narrow the device is. Anything
    // that resolves between that render and this effect's first run is lost
    // until the NEXT crossing, which on a phone that never rotates is never.
    //
    // Modelled here as the disagreement itself: `innerWidth` says desktop (what
    // the initialiser sees) while the media query says mobile (what is true).
    // Without `sync(query)` at subscribe time this stays open, and the drawer
    // covers the page from first paint.
    Object.defineProperty(window, 'innerWidth', { value: 1280, writable: true, configurable: true })
    width = 390
    render(<LocaleProvider><Sidebar /></LocaleProvider>)
    expect(offScreen()).toBe(true)
  })

  it('the toggle can still OPEN the drawer at mobile width', () => {
    // The blast radius of `sync(query)`, pinned (review finding). Before that
    // line existed, losing the effect's `[]` dependency array was a lint-level
    // slip: only `change` events set state, so re-subscribing every render was
    // wasteful and nothing more. With a mount-time sync it becomes
    // product-killing — the effect re-runs after every render, so tapping
    // `Open sidebar` sets `collapsed = false`, the re-render re-asserts the
    // media query, and the drawer slams shut. Primary navigation below `lg`
    // would be unopenable, the #1749 defect class.
    //
    // Measured: the suite stayed 8/8 green under exactly that one-token
    // deletion. Nothing else here taps the toggle — the browser test only
    // crosses the breakpoint, and the #1749 siblings mount fresh at mobile
    // width without ever crossing.
    width = 390
    Object.defineProperty(window, 'innerWidth', { value: 390, writable: true, configurable: true })
    render(<LocaleProvider><Sidebar /></LocaleProvider>)
    expect(offScreen()).toBe(true)

    act(() => {
      screen.getByRole('button', { name: 'Open sidebar' }).click()
    })
    expect(offScreen()).toBe(false)
  })

  it('releases the drawer again when the viewport widens', () => {
    // Not cosmetic: the state has to be released so a LATER narrowing is a
    // real crossing rather than a no-op. Invisible at `lg` either way, because
    // `lg:translate-x-0` pins the drawer open there.
    width = 390
    Object.defineProperty(window, 'innerWidth', { value: 390, writable: true, configurable: true })
    render(<LocaleProvider><Sidebar /></LocaleProvider>)
    expect(offScreen()).toBe(true)

    crossTo(false)
    expect(offScreen()).toBe(false)
  })
})
