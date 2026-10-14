import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '@/context/ThemeContext'
import { LocaleProvider } from '@/context/LocaleContext'

// The env badge is the other resident of the bar's rows; it is stubbed
// because this suite's claim is about the right cluster, and the badge keeps
// its own suite (EnvBadge.test.tsx). There is deliberately NO WalletButton
// mock any more (#3825): the bar no longer renders one, and a live
// WalletButton here would throw for want of wagmi's provider — so an
// accidental re-add fails this whole file, not just one assertion.
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

  it('places the theme toggle in the right cluster', () => {
    renderBar()

    const toggle = screen.getByRole('button', { name: /^Theme:/ })

    // The right cluster is the `ml-auto` flex row. The button sits one span
    // deeper than the cluster in the icon variant — this call site's gating
    // span; #2953 removed the Tooltip's trigger wrapper — so the cluster is
    // the button's grandparent.
    const cluster = toggle.parentElement?.parentElement
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

  // #3825: no wallet pill in the bar — signers live in Settings → Signers
  // and every signing flow connects in place (#3812).
  it('renders no wallet button', () => {
    const { container } = renderBar()
    // Positive control: the bar and its right cluster rendered.
    const toggle = screen.getByRole('button', { name: /^Theme:/ })
    const cluster = toggle.parentElement?.parentElement as HTMLElement
    // The cluster holds exactly the toggle's gating span — nothing beside it.
    expect(cluster.children).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /wallet/i })).toBeNull()
    expect(container.textContent ?? '').not.toMatch(/connect wallet|0x[0-9a-f]{4}/i)
  })

  it('renders no global account picker (#3719)', () => {
    renderBar()
    // Non-vacuity: the bar rendered its right cluster.
    expect(screen.getByRole('button', { name: /^Theme:/ })).toBeTruthy()
    // Haven has no "active" account: the bar carries no account dropdown, and
    // an account-specific action picks its account locally.
    expect(screen.queryByRole('button', { name: /active account/i })).toBeNull()
    expect(screen.queryByText('Manage accounts')).toBeNull()
  })
})
