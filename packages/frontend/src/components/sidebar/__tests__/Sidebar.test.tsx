import { act, fireEvent, render, screen } from '@testing-library/react'
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
import { TAB_ROUTES } from '@/components/sidebar/MobileTabBar'
import { SWIPE_DISMISS_PX } from '@/components/sidebar/MoreSheet'
import { LocaleProvider } from '@/context/LocaleContext'
import { ThemeProvider } from '@/context/ThemeContext'
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
        accounts: [],
      },
      logout: vi.fn(),
    })
  })

  it('renders Overview, Money and Agents (#3024, owner decision 2026-09-15; Overview once Analytics shipped)', () => {
    render(<LocaleProvider><ThemeProvider><Sidebar /></ThemeProvider></LocaleProvider>)
    // 'Admin' and 'Agent tools' are RETIRED labels (#3024): Custody was the
    // group's last reason to exist, and Contacts (the user's address book)
    // never belonged in "Agent tools" to begin with.
    expect(screen.queryByText('Admin')).toBeNull()
    expect(screen.queryByText('Agent tools')).toBeNull()
    // `selector: 'p'`: the group HEADER, not the "Agents" nav link's own label
    // — both render the text "Agents" and a bare `getByText` cannot tell them
    // apart.
    const labels = ['Overview', 'Money', 'Agents'].map((l) => screen.getByText(l, { selector: 'p' }))
    expect(labels).toHaveLength(3)
    // Order and routes (scoped to the nav — the logo also links to /dashboard):
    // Scoped to the DRAWER's landmark by name (#2731). `querySelector('nav')`
    // took the first `<nav>` in the DOM, and the mobile tab bar now renders
    // before this one — the assertion silently started measuring four tab
    // routes instead of the drawer's own.
    const links = Array.from(
      document.querySelector('nav[aria-label="All sections"]')!.querySelectorAll('a'),
    ).map((a) =>
      a.getAttribute('href'),
    )
    const nav = links.filter((href) =>
      ['/dashboard', '/accounts', '/transactions', '/analytics', '/agents', '/approvals', '/marketplace', '/contacts', '/accounting', '/custody'].includes(href ?? ''),
    )
    // '/approvals' and '/custody' stay in the FILTER above deliberately: the
    // filter is what makes this assertion able to see a re-added Approvals
    // entry, or a Custody entry that crept back in. Removing either from both
    // sides would turn the equality into a guard over a smaller set.
    expect(nav).toEqual([
      '/dashboard', '/analytics',
      '/accounts', '/transactions', '/accounting',
      // #3079: renamed from '/catalog'.
      '/agents', '/marketplace', '/contacts',
    ])
    // Header order in the DOM: Overview, then Money, then Agents — and
    // Dashboard sits UNDER the Overview header, not above it (the pre-#2947
    // ungrouped shape #3024 described as the interim). Scoped to the drawer's
    // `<nav>`, not `getByRole` — the mobile tab bar renders its own
    // "Dashboard" link too.
    const overview = screen.getByText('Overview', { selector: 'p' })
    const dashboard = document.querySelector('nav[aria-label="All sections"] a[href="/dashboard"]')!
    const money = screen.getByText('Money', { selector: 'p' })
    const agentsHeader = screen.getByText('Agents', { selector: 'p' })
    expect(overview.compareDocumentPosition(dashboard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(dashboard.compareDocumentPosition(money) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(money.compareDocumentPosition(agentsHeader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  /**
   * The rail's bottom section (#3024): Settings and the profile link come after
   * the labeled `<nav>`, in that order. The phone sheet's contents are pinned
   * in the `More sheet` block below, against the sheet itself.
   */
  it('the rail keeps Settings and Profile after the labeled sections', () => {
    render(<LocaleProvider><ThemeProvider><Sidebar /></ThemeProvider></LocaleProvider>)
    const rail = document.querySelector('aside')!
    const settingsLink = rail.querySelector('a[href="/settings"]')!
    const profileLink = rail.querySelector('a[aria-label^="Open profile for"]')!
    const lastRemaining = rail.querySelector('nav[aria-label="All sections"] a[href="/contacts"]')!
    expect(lastRemaining.compareDocumentPosition(settingsLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(settingsLink.compareDocumentPosition(profileLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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
        accounts: [
          { id: 's1', account_type: 'legacy_safe' },
          { id: 's2', account_type: 'delegator_hybrid' },
        ],
      },
      logout: vi.fn(),
    })
    render(<LocaleProvider><ThemeProvider><Sidebar /></ThemeProvider></LocaleProvider>)
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
      render(<LocaleProvider><ThemeProvider><Sidebar /></ThemeProvider></LocaleProvider>)
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
      render(<LocaleProvider><ThemeProvider><Sidebar /></ThemeProvider></LocaleProvider>)
      expect(accountingLink()).not.toBeNull()
      expect(attentionDot()).not.toBeNull()
      expect(attentionDot()!.textContent).toContain(en.accountingPage.nav.attention)
    })

    it('an exhausted sync raises the dot even on a healthy connection (#2866)', () => {
      mockAccountingFeed.mockReturnValue(feed(feedStatus({ counts: { pending: 0, failed: 3, exhausted: 1 } })))
      render(<LocaleProvider><ThemeProvider><Sidebar /></ThemeProvider></LocaleProvider>)
      expect(attentionDot()).not.toBeNull()
    })

    it('retryable failures alone do NOT raise it — the sweep owns those', () => {
      mockAccountingFeed.mockReturnValue(feed(feedStatus({ counts: { pending: 2, failed: 5, exhausted: 0 } })))
      render(<LocaleProvider><ThemeProvider><Sidebar /></ThemeProvider></LocaleProvider>)
      expect(attentionDot()).toBeNull()
    })

    it('hosted with the flag off: the entry stays, carrying the Soon pill (accessible name Coming soon) and no dot', () => {
      mockAccountingFeed.mockReturnValue(
        feed(feedStatus({ enabled: false, flagEnabled: false, available: false, entitled: false, connected: false, destination: null })),
      )
      render(<LocaleProvider><ThemeProvider><Sidebar /></ThemeProvider></LocaleProvider>)
      expect(accountingLink()).not.toBeNull()
      expect(accountingLink()!.textContent).toContain(en.accountingPage.nav.comingSoon)
      // The abbreviation is visual only (#2869 design review): the full
      // phrase is the accessible name — an `sr-only` node, not a `title` —
      // and the visible "Soon" is hidden from assistive tech.
      expect(accountingLink()!.querySelector('[title]')).toBeNull()
      const srOnly = accountingLink()!.querySelector('.sr-only:not([aria-hidden])')
      expect(srOnly?.textContent?.trim()).toBe(en.common.comingSoon)
      // jsdom's accname joins inline children without a separator; a browser
      // separates flex children. Either way the full phrase is in the name
      // and the abbreviation is not.
      expect(screen.getByRole('link', { name: new RegExp(`^Accounting\\s*${en.common.comingSoon}$`) })).toBe(accountingLink())
      expect(screen.queryByRole('link', { name: new RegExp(`Accounting\\s*${en.accountingPage.nav.comingSoon}$`) })).toBeNull()
      const abbreviated = Array.from(accountingLink()!.querySelectorAll('span')).find(
        (el) => el.textContent === en.accountingPage.nav.comingSoon,
      )
      expect(abbreviated?.getAttribute('aria-hidden')).toBe('true')
      // The rail shows only the abbreviation (#4053 — it no longer renders
      // below `lg`, where the sheet shows the full phrase; pinned in the
      // More sheet block below).
      const fullVisible = Array.from(accountingLink()!.querySelectorAll('span[aria-hidden="true"]')).find(
        (el) => el.textContent === en.common.comingSoon,
      )
      expect(fullVisible).toBeUndefined()
      expect(attentionDot()).toBeNull()
    })

    it('self-hosted: the entry is hidden, and never marked Coming soon', () => {
      mockAccountingFeed.mockReturnValue(
        feed(feedStatus({ hosted: false, enabled: false, flagEnabled: false, available: false, entitled: false, connected: false, destination: null })),
      )
      render(<LocaleProvider><ThemeProvider><Sidebar /></ThemeProvider></LocaleProvider>)
      expect(accountingLink()).toBeNull()
      // Positive control: the rest of the Money and Agents clusters are untouched.
      expect(document.querySelector('nav[aria-label="All sections"] a[href="/contacts"]')).not.toBeNull()
      const navText = document.querySelector('nav[aria-label="All sections"]')!.textContent ?? ''
      expect(navText).not.toContain(en.common.comingSoon)
      expect(navText).not.toContain(en.accountingPage.nav.comingSoon)
    })

    it('before the status answers: NO entry at all — nothing paints that a self-hosted answer would remove (#2869 review)', () => {
      mockAccountingFeed.mockReturnValue({ ...feed(null), loading: true })
      render(<LocaleProvider><ThemeProvider><Sidebar /></ThemeProvider></LocaleProvider>)
      expect(accountingLink()).toBeNull()
      expect(attentionDot()).toBeNull()
      // Positive control: the rest of the Money and Agents clusters do not wait.
      expect(document.querySelector('nav[aria-label="All sections"] a[href="/contacts"]')).not.toBeNull()
    })

    it('the status answers after mount: the entry appears once, in its final state', () => {
      mockAccountingFeed.mockReturnValue({ ...feed(null), loading: true })
      const { rerender } = render(<LocaleProvider><ThemeProvider><Sidebar /></ThemeProvider></LocaleProvider>)
      expect(accountingLink()).toBeNull()
      mockAccountingFeed.mockReturnValue(feed(feedStatus()))
      rerender(<LocaleProvider><ThemeProvider><Sidebar /></ThemeProvider></LocaleProvider>)
      expect(accountingLink()).not.toBeNull()
      expect(attentionDot()).toBeNull()
    })

    it('a FAILED status read renders the plain entry — never a marker it has not earned', () => {
      mockAccountingFeed.mockReturnValue({ ...feed(null), error: 'We could not load accounting status.' })
      render(<LocaleProvider><ThemeProvider><Sidebar /></ThemeProvider></LocaleProvider>)
      expect(accountingLink()).not.toBeNull()
      expect(attentionDot()).toBeNull()
      expect(accountingLink()!.textContent).not.toContain(en.accountingPage.nav.comingSoon)
    })
  })

  /**
   * The quick theme toggle's row, in the rail footer (#2928, ungated by
   * #4029). Below `lg` the rail is hidden (#4053).
   *
   * The row lives in the rail's footer with the rail's other controls — not in
   * the tab bar (`MobileTabBar.test.tsx` holds the negative side of that
   * boundary). It is the desktop theme control; below `lg` the More sheet
   * carries the three-way control instead (#4053). Three claims here:
   *
   *   1. the row is IN the footer, beside Settings and the user card;
   *   2. it is not inert. #2819 established that an illustration inside the
   *      drawer is `inert`, and an author reaching for that idiom here would
   *      produce a row that is visible, announced, and unreachable — with no
   *      console warning and no failing gate to notice it, the precise class
   *      of silent break that #2819 documents; and
   *   3. it has NO `lg:hidden` ancestor. The old reciprocal gate is dead: a
   *      wrapper re-added to "keep the mobile half mobile" would hide the
   *      app's only theme control on the desktop rail. jsdom has no media
   *      queries, so this is a className pin, not a layout claim; the live
   *      count-at-two-widths half of the invariant is an e2e assertion (see
   *      the PR for #4029).
   */
  it('carries the theme row in the footer, ungated at every width, live and not inert (#2928, #4029)', () => {
    render(<LocaleProvider><ThemeProvider><Sidebar /></ThemeProvider></LocaleProvider>)

    const row = screen.getByRole('button', { name: /^Theme:/ })
    expect(row).toBeTruthy()
    // The footer is the bordered block that also holds Settings and the user
    // card; the theme row must be inside it, not above the border line.
    const footer = row.closest('div[class*="border-t"]')
    expect(footer).not.toBeNull()
    expect(footer?.textContent).toContain('Settings')
    expect(footer?.textContent).toContain('Ada Lovelace')

    // Not inert, and no inert ancestor: this row is a control, not a picture.
    expect(row.hasAttribute('inert')).toBe(false)
    expect(row.closest('[inert]')).toBeNull()

    // The visible label is contained in the accessible name (WCAG 2.5.3), so
    // the row reads as the other rows of the sheet do and a voice command
    // naming the label activates it.
    expect(row.textContent).toContain('Theme')

    // NO `lg:hidden` ancestor (#4029). The row is the rail's — the desktop
    // — theme control; a gate hiding it at `lg` would strand desktop users
    // without one, and jsdom has no media queries to catch it the honest way,
    // so the className is pinned. Below `lg` the whole rail is `hidden` and
    // the More sheet carries the three-way control instead (#4053).
    const gatedAncestor = row.closest('div[class*="lg:hidden"]')
    expect(
      gatedAncestor,
      'the theme row must have no lg:hidden ancestor — it is the desktop theme control',
    ).toBeNull()

    // Exactly one theme control in the document while the sheet is closed.
    expect(screen.queryAllByRole('button', { name: /^Theme:/ })).toHaveLength(1)
    expect(screen.queryAllByRole('radiogroup', { name: 'Theme' })).toHaveLength(0)
  })

  /**
   * The environment badge sits OFF the wordmark (#4053 — it rendered as
   * "HavenDEV"). No visual baseline can show this: `EnvBadge` renders nothing
   * in production and the Playwright server sets no `NEXT_PUBLIC_HAVEN_ENV`,
   * so the band is pinned here with the variable set. A className pin — jsdom
   * has no layout — on the band that holds both, read from the rendered DOM.
   */
  it('keeps a gap between the wordmark and the environment badge', () => {
    vi.stubEnv('NEXT_PUBLIC_HAVEN_ENV', 'dev')
    try {
      render(<LocaleProvider><ThemeProvider><Sidebar /></ThemeProvider></LocaleProvider>)
      const badge = screen.getByText('dev')
      const band = badge.closest('[data-logo-band]')!
      expect(band).not.toBeNull()
      expect(band.textContent).toContain('Haven')
      expect(band.className.split(/\s+/)).toContain('gap-2')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('opens profile from the bottom-left identity area', () => {
    render(<LocaleProvider><ThemeProvider><Sidebar /></ThemeProvider></LocaleProvider>)

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
        accounts: [],
      },
      logout,
    })
    render(<LocaleProvider><ThemeProvider><Sidebar /></ThemeProvider></LocaleProvider>)

    await user.click(screen.getByRole('button', { name: 'User menu' }))

    expect(screen.getByRole('menuitem', { name: 'Profile' })).toHaveAttribute('href', '/profile')
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute('href', '/settings')
    await user.click(screen.getByRole('menuitem', { name: 'Log out' }))

    expect(logout).toHaveBeenCalled()
    expect(mockPush).toHaveBeenCalledWith('/')
  })
})

/**
 * The phone More sheet across the `lg` breakpoint (#2586, #4053).
 *
 * #2586's defect was a drawer left on top of the page after a narrowing. Since
 * #4053 the rail is CSS-hidden below `lg` and the phone menu is a sheet that
 * starts closed, so what this block pins is the state machine: the sheet only
 * ever opens below `lg`, widening closes it, narrowing never reopens it, and
 * the mount-time sync corrects a rounded `innerWidth`. Plus the sheet's own
 * contents and every way it closes.
 *
 * Driven through `matchMedia` rather than `window.innerWidth` + a `resize`
 * event, because that is what the component listens to; a test that fired
 * `resize` would pass against an implementation that handles neither.
 */
describe('More sheet across the desktop breakpoint (#2586, #4053)', () => {
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
  // #2928: the drawer now renders the theme row, so these tests mount a real
  // ThemeProvider and a real ThemeToggle on top of the mock. They ask two
  // further questions of `matchMedia` — the provider the colour-scheme one, the
  // toggle the motion one — and both are modelled here (answered, never
  // driven: a width change must not reach their listeners, see
  // addEventListener). The file's standing rule survives intact: a query in
  // NONE of these three still fails loudly, which is what caught the two
  // mutations this block was written for.
  const COLOUR_SCHEME_QUERY = '(prefers-color-scheme: dark)'
  const MOTION_QUERY = '(prefers-reduced-motion: reduce)'
  /** These tests model a light device with no motion preference. */
  const NO_MATCH = false
  const listeners = new Set<(e: MediaQueryListEvent) => void>()
  let width = 1280

  const installMatchMedia = () => {
    listeners.clear()
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string) => {
        // #2928: the drawer footer gained the theme row, so these tests now
        // mount a real ThemeProvider and a real ThemeToggle on top of this
        // mock. They ask two further questions of it — the provider the
        // colour-scheme one, the toggle the motion one — and both are ANSWERED
        // here (a light device with no motion preference) but never DRIVEN: a
        // viewport resize fires this block's `listeners`, and a provider or
        // toggle listener handed that width-derived event would be told "the OS
        // switched to dark" by a resize. The standing rule of this mock is
        // intact — a query in NONE of the three named constants still fails
        // loudly, which is what caught the two mutations (#2586) this block was
        // written for.
        if (
          query !== DESKTOP_QUERY &&
          query !== COLOUR_SCHEME_QUERY &&
          query !== MOTION_QUERY
        ) {
          expect(query, 'Sidebar asked matchMedia a query this mock does not model').toBe(
            DESKTOP_QUERY,
          )
        }
        return {
          // A getter, so it tracks `width` the way a real MediaQueryList
          // tracks the viewport instead of freezing at construction.
          get matches() {
            if (query === COLOUR_SCHEME_QUERY || query === MOTION_QUERY) return NO_MATCH
            return width >= 1024
          },
          media: query,
          onchange: null,
          addEventListener: (type: string, fn: (e: MediaQueryListEvent) => void) => {
            // Registered by QUERY, not fanned out to every listener: this
            // block's `setWidth` fires `listeners` with a width-derived
            // `matches`, and a motion listener that received it would be told
            // "the OS switched to reduce" by a viewport resize. The toggle's
            // motion listener is therefore registered nowhere — these tests
            // never flip motion, and a listener nobody drives is honest.
            if (type === 'change' && query === DESKTOP_QUERY) listeners.add(fn)
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

  const sheet = () => document.querySelector('[data-more-sheet]') as HTMLElement | null
  const moreButton = () => document.querySelector('[data-more-toggle]') as HTMLButtonElement
  const renderSidebar = () =>
    render(<LocaleProvider><ThemeProvider><Sidebar /></ThemeProvider></LocaleProvider>)
  const mountAt = (w: number) => {
    width = w
    Object.defineProperty(window, 'innerWidth', { value: w, writable: true, configurable: true })
    return renderSidebar()
  }
  const openSheet = () => {
    act(() => {
      screen.getByRole('button', { name: 'Open sidebar' }).click()
    })
  }

  beforeEach(() => {
    mockUsePathname.mockReturnValue('/dashboard')
    mockUseAuth.mockReturnValue({
      user: { name: 'Ada Lovelace', email: 'ada@example.com', accounts: [] },
      logout: vi.fn(),
    })
    mockAccountingFeed.mockReset().mockReturnValue(feed(feedStatus()))
    width = 1280
    installMatchMedia()
  })

  it('a fresh mount at mobile width starts with the sheet closed', () => {
    mountAt(390)
    expect(sheet()).toBeNull()
    expect(moreButton().getAttribute('aria-label')).toBe('Open sidebar')
  })

  it('the More cell OPENS the sheet at mobile width, and closes it again', () => {
    // The More cell is the only way in below `lg`: if it stopped toggling,
    // everything the tab bar does not carry would be unreachable on a phone.
    mountAt(390)
    openSheet()
    expect(sheet()).not.toBeNull()
    expect(moreButton().getAttribute('aria-label')).toBe('Close sidebar')
    expect(moreButton().getAttribute('aria-expanded')).toBe('true')
    act(() => {
      screen.getByRole('button', { name: 'Close sidebar' }).click()
    })
    expect(sheet()).toBeNull()
  })

  it('never renders on desktop, even when More is pressed', () => {
    mountAt(1280)
    openSheet()
    expect(sheet()).toBeNull()
  })

  it('syncs on mount when the initialiser and the media query disagree', () => {
    // `innerWidth` is rounded and the media query is not: a 1023.x CSS-px
    // viewport reads innerWidth 1024 (the initialiser says desktop) while
    // `(min-width: 1024px)` is false. Without `sync(query)` at subscribe time
    // the component would believe it is on desktop and More would do nothing.
    Object.defineProperty(window, 'innerWidth', { value: 1280, writable: true, configurable: true })
    width = 390
    renderSidebar()
    openSheet()
    expect(sheet()).not.toBeNull()
  })

  it('widening past lg closes the sheet, and a later narrowing does not reopen it', () => {
    mountAt(390)
    openSheet()
    expect(sheet()).not.toBeNull()
    crossTo(false)
    expect(sheet()).toBeNull()
    crossTo(true)
    expect(sheet()).toBeNull()
  })

  it('lists only the destinations the tab bar lacks — no tab route, each item once', () => {
    mountAt(390)
    openSheet()
    const hrefs = Array.from(sheet()!.querySelectorAll('a[href]')).map((a) => a.getAttribute('href'))
    // ABSENCE, derived from `TAB_ROUTES` itself: the drawer #4053 replaced
    // listed all four tab routes again.
    for (const route of TAB_ROUTES) expect(hrefs, `sheet repeats tab route ${route}`).not.toContain(route)
    const nav = sheet()!.querySelector('nav[aria-label="All sections"]')!
    const navHrefs = Array.from(nav.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(navHrefs).toEqual(['/analytics', '/accounting', '/marketplace', '/contacts', '/settings'])
    // Settings once in the whole sheet (the drawer had it in the footer AND
    // inside the kebab menu).
    expect(hrefs.filter((h) => h === '/settings')).toHaveLength(1)
  })

  it('opens with the account, shows Log out as a visible row and has no kebab', () => {
    const logout = vi.fn()
    mockUseAuth.mockReturnValue({
      user: { name: 'Ada Lovelace', email: 'ada@example.com', accounts: [] },
      logout,
    })
    mountAt(390)
    openSheet()
    const s = sheet()!
    const profile = s.querySelector('a[aria-label="Open profile for Ada Lovelace"]')!
    expect(profile.getAttribute('href')).toBe('/profile')
    expect(profile.textContent).toContain('ada@example.com')
    // Account comes before the destinations.
    const firstDestination = s.querySelector('nav a')!
    expect(profile.compareDocumentPosition(firstDestination) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(s.querySelector('button[aria-label="User menu"]')).toBeNull()
    const logOut = Array.from(s.querySelectorAll('button')).find((b) => b.textContent === 'Log out')!
    expect(logOut).toBeTruthy()
    act(() => logOut.click())
    expect(logout).toHaveBeenCalledTimes(1)
    expect(mockPush).toHaveBeenCalledWith('/')
  })

  it('offers the three-way theme choice, writing the same preference as Settings', () => {
    mountAt(390)
    openSheet()
    const group = screen.getByRole('radiogroup', { name: 'Theme' })
    const options = Array.from(group.querySelectorAll('[role="radio"]')).map((o) => o.textContent)
    expect(options).toEqual(['Light', 'Dark', 'System'])
    act(() => (group.querySelector('[role="radio"]') as HTMLButtonElement).click())
    expect(localStorage.getItem('haven.theme')).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('Escape dismisses it and hands focus back to More', async () => {
    mountAt(390)
    openSheet()
    expect(sheet()!.contains(document.activeElement)).toBe(true)
    await userEvent.keyboard('{Escape}')
    expect(sheet()).toBeNull()
    expect(document.activeElement).toBe(moreButton())
  })

  it('a scrim tap dismisses it', () => {
    mountAt(390)
    openSheet()
    act(() => (document.querySelector('[data-more-sheet-scrim]') as HTMLElement).click())
    expect(sheet()).toBeNull()
  })

  it('a downward swipe on the handle past the threshold dismisses it; a short one does not', () => {
    mountAt(390)
    openSheet()
    const drag = (dy: number) => {
      const handle = document.querySelector('[data-more-sheet-handle]') as HTMLElement
      fireEvent.pointerDown(handle, { clientY: 400, pointerId: 1 })
      fireEvent.pointerMove(handle, { clientY: 400 + dy, pointerId: 1 })
      fireEvent.pointerUp(handle, { clientY: 400 + dy, pointerId: 1 })
    }
    drag(SWIPE_DISMISS_PX - 1)
    expect(sheet()).not.toBeNull()
    drag(SWIPE_DISMISS_PX)
    expect(sheet()).toBeNull()
  })

  it('closes on any route change — a tab tap included', () => {
    const view = mountAt(390)
    openSheet()
    expect(sheet()).not.toBeNull()
    mockUsePathname.mockReturnValue('/agents')
    view.rerender(<LocaleProvider><ThemeProvider><Sidebar /></ThemeProvider></LocaleProvider>)
    expect(sheet()).toBeNull()
  })

  it('a tap on the tab you are already on closes it — no route change involved', () => {
    // On /dashboard, tapping Dashboard navigates nowhere, so the pathname
    // effect cannot fire; the tab's own click has to close the sheet.
    mountAt(390)
    openSheet()
    const bar = document.querySelector('[data-mobile-tab-bar]')!
    act(() => (bar.querySelector('a[href="/dashboard"]') as HTMLAnchorElement).click())
    expect(sheet()).toBeNull()
  })

  it('shows Accounting with its full Coming soon phrase and its attention dot', () => {
    mockAccountingFeed.mockReturnValue(feed(feedStatus({ enabled: false, flagEnabled: false })))
    const view = mountAt(390)
    openSheet()
    const entry = sheet()!.querySelector('a[href="/accounting"]')!
    expect(entry.textContent).toContain(en.common.comingSoon)
    expect(entry.textContent).not.toContain(en.accountingPage.nav.comingSoon + en.common.comingSoon)
    view.unmount()

    mockAccountingFeed.mockReturnValue(
      feed(feedStatus({ counts: { pending: 0, failed: 0, exhausted: 2 } })),
    )
    mountAt(390)
    openSheet()
    expect(sheet()!.querySelector('[data-testid="nav-attention-accounting"]')).not.toBeNull()
  })

  it('a destination tap closes it', () => {
    mountAt(390)
    openSheet()
    act(() => (sheet()!.querySelector('a[href="/analytics"]') as HTMLAnchorElement).click())
    expect(sheet()).toBeNull()
  })
})
