import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockUseAuth,
  mockUseAccounts,
  mockUseAgents,
  mockUsePreferences,
} = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockUseAccounts: vi.fn(),
  mockUseAgents: vi.fn(),
  mockUsePreferences: vi.fn(),
}))

vi.mock('@/context/AuthContext', () => ({ useAuth: () => mockUseAuth() }))
vi.mock('@/hooks/useAccounts', () => ({ useAccounts: () => mockUseAccounts() }))
vi.mock('@/hooks/useAgents', () => ({ useAgents: () => mockUseAgents() }))
vi.mock('@/hooks/usePreferences', () => ({ usePreferences: () => mockUsePreferences() }))
const { mockUsePortfolio } = vi.hoisted(() => ({ mockUsePortfolio: vi.fn() }))
vi.mock('@/hooks/usePortfolio', () => ({
  usePortfolio: (...args: unknown[]) => mockUsePortfolio(...args),
}))
vi.mock('@/hooks/useDeployableChains', () => ({
  useDeployableChains: () => ({
    chains: [
      { chainId: 8453, name: 'Base' },
      { chainId: 84532, name: 'Base Sepolia' },
    ],
    loading: false,
  }),
}))
vi.mock('wagmi', () => ({ useAccount: () => ({ address: undefined, isConnected: false }) }))
vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: Object.assign(() => null, { Custom: () => null }),
}))

import AccountsOverviewClient from '../AccountsOverviewClient'

function account(id: string, name: string, chainId: number, isDefault = false) {
  return {
    id,
    account_address: `0x${id.padEnd(40, '0')}`,
    chain_id: chainId,
    name,
    is_default: isDefault,
    created_at: '2026-06-01T00:00:00Z',
  }
}

const BASE = account('base1', 'Base account', 8453, true)
const SEPOLIA = account('sep1', 'Sepolia account', 84532)

function getAccountCard(name: string): HTMLElement {
  const card = screen.getByRole('link', { name }).closest('[data-testid="account-card"]')
  if (!(card instanceof HTMLElement)) throw new Error(`Missing account card for ${name}`)
  return card
}

describe('AccountsOverviewClient — no global active account (#3719)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseAgents.mockReturnValue({ agents: [] })
    mockUsePreferences.mockReturnValue({ currency: 'USD' })
    mockUsePortfolio.mockReturnValue({ totalUsd: 0, totalEur: 0, totalSek: 0, breakdown: [], loading: false })
    mockUseAccounts.mockReturnValue({
      accounts: [BASE, SEPOLIA],
      loading: false,
    })
    mockUseAuth.mockReturnValue({ user: { accounts: [BASE, SEPOLIA] } })
  })

  it('marks no account as active and offers no Set active control', () => {
    render(<AccountsOverviewClient />)

    // Non-vacuity: both cards rendered.
    const baseCard = getAccountCard('Base account')
    const sepoliaCard = getAccountCard('Sepolia account')

    for (const card of [baseCard, sepoliaCard]) {
      expect(within(card).queryByText('Active')).toBeNull()
      expect(within(card).queryAllByRole('button')).toEqual([])
    }
    expect(screen.queryByText('Set active')).toBeNull()
    expect(screen.queryByLabelText(/as active/i)).toBeNull()
  })

  it('each card is a plain link to its account', () => {
    render(<AccountsOverviewClient />)

    const link = screen.getByRole('link', { name: 'Sepolia account' })
    expect(link).toHaveAttribute('href', '/accounts/sep1')
    expect(link.className).toContain('after:absolute')
  })

  /**
   * #3127: a SEK preference must show SEK figures read from the portfolio
   * hook's `totalSek` / `sekValue` — the pre-#3127 card had no SEK branch and
   * served the USD figure.
   *
   * Review round 2, finding 6: this test USED to pin the card's own prefix
   * formatter (`kr13,000.50`) as "deliberately unlike" the dashboard — the
   * pin that licensed a USD-style total wearing a SEK label one click from
   * the surface that does it right. The divergence is gone: all three fiat
   * surfaces now render through the ONE shared `lib/format.ts` `formatFiat`,
   * so this card renders the same sv-SE suffix voice as `/dashboard` and
   * `/accounts/[id]` — `13 000,50 kr`, NBSP included — and this test pins
   * that unified output instead.
   */
  it('renders SEK figures from the portfolio hook when the preference is SEK', () => {
    mockUsePreferences.mockReturnValue({ currency: 'SEK' })
    mockUsePortfolio.mockReturnValue({
      totalUsd: 1234.56,
      totalEur: 1100,
      totalSek: 13000.5,
      breakdown: [
        { symbol: 'USDC', balance: '1000000', formatted: '1.00', usdValue: 1, eurValue: 0.92, sekValue: 9.4 },
      ],
      loading: false,
    })
    render(<AccountsOverviewClient />)

    const activeCard = getAccountCard('Base account')
    // getByText needles are PLAIN-SPACE: RTL's normalizer collapses the
    // sv-SE NBSPs on the node side but not in the needle. The exact NBSP
    // bytes are pinned separately below via textContent.
    expect(within(activeCard).getByText('13 000,50 kr')).toBeInTheDocument()
    expect(within(activeCard).getByText('9,40 kr')).toBeInTheDocument()
    // Byte-exact pin: the unified formatter's output is NBSP-separated
    // (`13\u00a0000,50\u00a0kr`), not a plain-space lookalike.
    const totals = within(activeCard).getAllByText(/kr$/).map((el) => el.textContent)
    expect(totals).toContain('13\u00a0000,50\u00a0kr')
    expect(totals).toContain('9,40\u00a0kr')
    // The USD/EUR figures stay off the card.
    expect(within(activeCard).queryByText('$1,234.56')).toBeNull()
    expect(within(activeCard).queryByText('1.100,00 €')).toBeNull()
  })
})

/**
 * The dashboard half of the inflow closure (#1984, epic #1440).
 *
 * `AddSafeModal` was the only place in the signed-in app that could mint or
 * attach a Safe: a three-mode modal (choose / deploy / import) reached from
 * an "Add account" button in the page header and from the empty state's
 * "Add your first account". Both routes it called now answer 410, so the
 * trigger is gone with the modal. Asserting the ABSENCE of an affordance is
 * weak by nature, so this asserts it in both states the page can be in and
 * on both the accessible name and the modal's own headings — the specific
 * strings a reintroduction would have to render.
 */
describe('AccountsOverviewClient — the Safe inflow is closed (#1984)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseAgents.mockReturnValue({ agents: [] })
    mockUsePreferences.mockReturnValue({ currency: 'USD' })
    mockUseAuth.mockReturnValue({ user: { accounts: [BASE, SEPOLIA] } })
  })

  it('offers no Add-account entry point when accounts exist', () => {
    mockUseAccounts.mockReturnValue({
      accounts: [BASE, SEPOLIA],
      loading: false,
    })

    render(<AccountsOverviewClient />)

    // The cards still render — this is a read/manage surface, not a deletion.
    expect(screen.getByRole('link', { name: 'Base account' })).toBeInTheDocument()

    expect(screen.queryByRole('button', { name: /add account/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /add your first account/i })).toBeNull()
    expect(screen.queryByText('Import existing account')).toBeNull()
    expect(screen.queryByText('Create Haven account')).toBeNull()
  })

  it('offers no Add-account entry point from the empty state either', () => {
    mockUseAccounts.mockReturnValue({ accounts: [], loading: false })

    render(<AccountsOverviewClient />)

    expect(screen.getByText('No Haven accounts yet')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add/i })).toBeNull()
    expect(screen.queryByText('Import existing account')).toBeNull()
  })
})


/**
 * #2374 — the card's "set as default" star is gone, by owner decision.
 *
 * It was an unlabelled outline glyph whose meaning lived only in `aria-label`.
 * #2241 made it permanently visible on touch (correctly — before that it was
 * invisible AND still tappable, which is worse), and that sharpened rather than
 * created the problem: a sighted touch user got a bare star with no label and
 * no tooltip fallback. Labelling it costs the title row ~72px that #2223 /
 * #2235 / #2236 spent three issues protecting, and a tooltip inside a composite
 * interactive control is hover-only by design (#2038), so it would explain
 * nothing on the device the finding was about. The action lives on
 * `/accounts/<id>` instead, where it always has.
 *
 * ## Why the absences below are asserted the way they are
 *
 * Asserting an absence is weak by nature — the same caution the inflow-closure
 * block above states — so this follows the same three rules:
 *
 *  1. **Non-vacuity first.** Every case asserts the card IS rendered and the
 *     absence scan itself finds a real control — the card's own name link —
 *     before asserting anything is missing. A component that threw, or a scan
 *     that can never return anything, would otherwise read as a clean
 *     removal. (Until #3719 the surviving control was "Set active"; that is
 *     gone with the global active account, so the scan covers links too.)
 *  2. **Both spellings.** The scan matches any control whose accessible name
 *     or visible text mentions "default", not the star's old exact label — so
 *     it also fails on the labelled `Set default` variant the decision
 *     rejected, and on a kebab item added to the card later.
 *  3. **The state where it mattered most gets its own case.** A single
 *     NON-default account: both badges are gated on `accounts.length > 1`, so the
 *     word `default` renders nowhere on the page, and `/accounts/<id>` hides
 *     its own set-default action in exactly this state — while the card's star
 *     was gated on `!account.is_default` alone and rendered anyway.
 *
 * The `default` BADGE is deliberately NOT swept up: it is a `span`, and the
 * chip that NAMES the state stays. Only the control that SET it from the card
 * is gone. The first case below asserts that explicitly, so a later "cleanup"
 * that deletes the chip too fails here rather than passing as more of the same.
 */
describe('AccountsOverviewClient — the card has no set-default control (#2374)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseAgents.mockReturnValue({ agents: [] })
    mockUsePreferences.mockReturnValue({ currency: 'USD' })
    mockUseAuth.mockReturnValue({ user: { accounts: [BASE, SEPOLIA] } })
  })

  /** Every control on the page whose accessible name or text mentions the word. */
  function controlsMentioning(word: RegExp): string[] {
    return [...screen.queryAllByRole('button'), ...screen.queryAllByRole('link')]
      .map((el) => `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''}`.trim())
      .filter((n) => word.test(n))
  }

  it('offers no set-default control with several accounts, while keeping the default badge', () => {
    mockUseAccounts.mockReturnValue({ accounts: [BASE, SEPOLIA], loading: false })

    render(<AccountsOverviewClient />)

    // Non-vacuity: the cards rendered, and the same scan finds a real control.
    // `.some(includes)` rather than `toContain`: the scan concatenates the
    // accessible name with the visible text, so an exact match would be
    // asserting the concatenation format instead of the control's presence.
    expect(
      controlsMentioning(/Sepolia account/).some((n) => n.includes('Sepolia account')),
      `the absence scan found no control to prove itself on — it saw ${JSON.stringify(controlsMentioning(/account/i))}`,
    ).toBe(true)

    expect(controlsMentioning(/default/i)).toEqual([])
    expect(screen.queryByLabelText(/set .* as default/i)).toBeNull()

    // The chip that NAMES the default account stays — only the control that
    // set it from the card is gone. BASE is the default of two accounts, so
    // `showDefaultBadge` is satisfied.
    expect(within(getAccountCard('Base account')).getByText('default')).toBeInTheDocument()
  })

  it('offers no set-default control for a lone NON-default account either', () => {
    const LONE = account('lone1', 'Lone account', 8453, false)
    mockUseAccounts.mockReturnValue({ accounts: [LONE], loading: false })
    mockUseAuth.mockReturnValue({ user: { accounts: [LONE] } })

    render(<AccountsOverviewClient />)

    // Non-vacuity: the card is there under its own name, AND the absence scan
    // itself demonstrably finds a real control before it is trusted to find
    // none.
    expect(screen.getByRole('link', { name: 'Lone account' })).toBeInTheDocument()
    expect(
      controlsMentioning(/Lone account/).some((n) => n.includes('Lone account')),
      `the absence scan found no control to prove itself on — it saw ${JSON.stringify(controlsMentioning(/account/i))}`,
    ).toBe(true)

    // The state the star was worst in: no badge says "default" anywhere, the
    // detail page hides the same action here, and the star rendered anyway.
    expect(screen.queryByText('default')).toBeNull()
    expect(controlsMentioning(/default/i)).toEqual([])
  })
})
