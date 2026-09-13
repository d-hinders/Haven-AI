import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '@/context/ThemeContext'
import { LocaleProvider } from '@/context/LocaleContext'

// The bar is the layout; these three are the other residents of its rows, and
// each reaches past its own wallet-connector/provider stack. They are stubbed
// to nothing because this suite's claim is about the theme toggle's place in
// the right cluster — and a live WalletButton would make the whole file depend
// on wagmi and RainbowKit contexts it is not testing. Their absence is
// asserted nowhere; the components keep their own suites (WalletButton.test.tsx
// covers the wallet, EnvBadge.test.tsx the badge, NetworkSwitcher.test.tsx the
// chain).
vi.mock('../WalletButton', () => ({
  default: () => <span data-testid="stub-wallet-button" />,
}))
vi.mock('../NetworkSwitcher', () => ({
  default: () => <span data-testid="stub-network-switcher" />,
}))
vi.mock('../EnvBadge', () => ({
  default: () => <span data-testid="stub-env-badge" />,
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
}))

import TopBar from '../TopBar'

/**
 * The top bar's right cluster (#2928): the theme toggle sits beside the wallet
 * button, and it is the desktop half of a control whose mobile half is the row
 * in the tab bar's More sheet (Sidebar.test.tsx covers that one).
 *
 * The bar composes, the bar decorates — but the two claims this file makes are
 * behavioural, not decorative:
 *
 *   1. the control is in the RIGHT cluster and next to the wallet button, in
 *      that order — the cluster is where a `WalletButton` has always lived, and
 *      a toggle placed in the left one would sit against the account chip on a
 *      phone; and
 *   2. it is the one toggle, and it works: its name states the palette on
 *      screen and the one a click brings, and a press flips it (#2953).
 *
 * What the file does NOT assert is which of the two renderings is on screen at
 * a given width. `hidden lg:inline-flex` is a class string, and jsdom has no
 * layout: an assertion on it would be a string match wearing an assertion, and
 * it would go on passing whether or not the media query exists. The rendered
 * truth of that gate is the Playwright spec.
 */
function renderBar() {
  return render(
    <LocaleProvider>
      <ThemeProvider>
        <TopBar />
      </ThemeProvider>
    </LocaleProvider>,
  )
}

describe('TopBar', () => {
  beforeEach(() => {
    window.localStorage.clear()
    delete document.documentElement.dataset.theme
  })

  it('places the theme toggle in the right cluster, before the wallet button', () => {
    const { container } = renderBar()

    const toggle = screen.getByRole('button', { name: /^Theme:/ })
    const wallet = screen.getByTestId('stub-wallet-button')

    // Document order, not a class read: a class is a string, the tree order
    // is a fact. `compareDocumentPosition` carries the XML-DOM quirk — "a
    // before b" answers with the FOLLOWING bit, and "a after b" with
    // PRECEDING|FOLLOWING — so the bit test alone proves only that the two
    // share a tree (which is what `Sidebar.test.tsx` leans on for its label
    // order). Asserting the NUMBER is what actually pins the direction:
    // equality with FOLLOWING is true only when the toggle is first.
    expect(toggle.compareDocumentPosition(wallet)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    // The right cluster is the `ml-auto` flex row the toggle and the wallet
    // share. The button sits one span deeper than the cluster in the icon
    // variant — this call site's gating span; #2953 removed the Tooltip's
    // trigger wrapper — so the shared ancestor is the button's grandparent,
    // and the wallet button is a direct child of it. Identity, not a class
    // substring: the two elements must be the same node.
    const cluster = toggle.parentElement?.parentElement
    expect(cluster).toBe(wallet.parentElement)
    // The `ml-auto` is what makes this THE right cluster rather than the left
    // one: it is the only thing pushing the row off the left edge of the bar,
    // and in the left cluster the toggle would sit against the account chip on
    // a phone (#1767 is the history of exactly that crowding).
    expect(/\bml-auto\b/.test(cluster?.className ?? '')).toBe(true)
    expect(/\bgap-3\b/.test(cluster?.className ?? '')).toBe(true)
  })

  it.each([
    ['light', 'Theme: light. Switch to dark'],
    ['dark', 'Theme: dark. Switch to light'],
  ] as const)(
    'announces its state and its next from %s in the bar',
    async (stored, name) => {
      window.localStorage.setItem('haven.theme', stored)
      renderBar()
      await waitFor(() => expect(screen.queryByRole('button', { name })).not.toBeNull())
      expect(screen.queryAllByRole('button', { name: /^Theme:/ })).toHaveLength(1)
    },
  )

  it('flips the theme from the bar with a single press (#2953 two-state)', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem('haven.theme', 'light')
    renderBar()
    const toggle = await screen.findByRole('button', { name: 'Theme: light. Switch to dark' })

    await user.click(toggle)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Theme: dark. Switch to light' })).toBeTruthy(),
    )
    expect(window.localStorage.getItem('haven.theme')).toBe('dark')
    // The bar and the drawer read one store: the attribute that selects the
    // token block in globals.css is the same one the More sheet's row drives.
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('leaves the five tabs of the bottom bar alone — the toggle is not a tab', () => {
    renderBar()
    // The tab bar belongs to Sidebar (#2731, five tabs, the sixth slot a
    // sibling); a theme control added to the top bar must not have become a
    // sixth tab there. The bar is not rendered by this component at all, so
    // the negative assertion is cheap and it is a guard against a future
    // "move it into the bar" edit that reads like a tidy-up.
    expect(screen.queryByRole('navigation')).toBeNull()
    expect(document.querySelectorAll('[data-mobile-tab-bar]')).toHaveLength(0)
  })
})
