import { fireEvent, render, screen, within } from '@testing-library/react'
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
// The New account dialog's own signer read (#4024) — only reached once the
// dialog is open; its behaviour is NewAccountDialog.test.tsx's.
vi.mock('@/hooks/useUserSigners', () => ({
  useUserSigners: () => ({ signers: [], loadError: false, reload: vi.fn() }),
}))
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
    mockUsePortfolio.mockReturnValue({ totalUsd: 0, totalEur: 0, totalSek: 0, breakdown: [], lastOutgoingAt: null, loading: false })
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
   *
   * #4021: moved to a TWO-token fixture. A single non-zero token now renders
   * NO rows (it would just repeat the headline), so per-row SEK formatting
   * needs a second holding to stay covered.
   */
  it('renders SEK figures from the portfolio hook when the preference is SEK', () => {
    mockUsePreferences.mockReturnValue({ currency: 'SEK' })
    mockUsePortfolio.mockReturnValue({
      totalUsd: 1234.56,
      totalEur: 1100,
      totalSek: 13000.5,
      breakdown: [
        { symbol: 'USDC', balance: '1000000', formatted: '1.00', usdValue: 1, eurValue: 0.92, sekValue: 9.4 },
        { symbol: 'ETH', balance: '10000000000000000', formatted: '0.01', usdValue: 33, eurValue: 30, sekValue: 316 },
      ],
      lastOutgoingAt: null,
      loading: false,
    })
    render(<AccountsOverviewClient />)

    const activeCard = getAccountCard('Base account')
    // getByText needles are PLAIN-SPACE: RTL's normalizer collapses the
    // sv-SE NBSPs on the node side but not in the needle. The exact NBSP
    // bytes are pinned separately below via textContent.
    expect(within(activeCard).getByText('13 000,50 kr')).toBeInTheDocument()
    expect(within(activeCard).getByText('9,40 kr')).toBeInTheDocument()
    expect(within(activeCard).getByText('316,00 kr')).toBeInTheDocument()
    // Byte-exact pin: the unified formatter's output is NBSP-separated
    // (`13\u00a0000,50\u00a0kr`), not a plain-space lookalike.
    const totals = within(activeCard).getAllByText(/kr$/).map((el) => el.textContent)
    expect(totals).toContain('13\u00a0000,50\u00a0kr')
    expect(totals).toContain('9,40\u00a0kr')
    expect(totals).toContain('316,00\u00a0kr')
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
 * trigger is gone with the modal.
 *
 * #4024 re-scoped these from "no account entry point" to "no SAFE entry
 * point". The Accounts screen now has a create action — "New account", which
 * provisions a passkey-owned delegation-rail account — so a test that asked
 * whether any add/create control exists would be asserting something false,
 * and one that only queried `/add account/i` would pass vacuously next to it.
 * What #1984 closed is the Safe deploy/import flow, so the absences below are
 * that flow's own strings: its trigger labels and its modal's headings and
 * actions, the specific text a reintroduction would have to render.
 */
const SAFE_INFLOW_STRINGS = [
  'Add your first account',
  'Import existing account',
  'Import account',
  'Create Haven account',
  'Connect a wallet to deploy',
  'Create a new Haven account or import one you already use.',
]

function expectNoSafeInflow() {
  expect(screen.queryByRole('button', { name: /^add account$/i })).toBeNull()
  for (const text of SAFE_INFLOW_STRINGS) {
    expect(screen.queryByText(text), `the retired Safe flow rendered "${text}"`).toBeNull()
    expect(screen.queryByRole('button', { name: text })).toBeNull()
  }
}

describe('AccountsOverviewClient — the Safe inflow is closed (#1984)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseAgents.mockReturnValue({ agents: [] })
    mockUsePreferences.mockReturnValue({ currency: 'USD' })
    mockUseAuth.mockReturnValue({ user: { accounts: [BASE, SEPOLIA] } })
  })

  it('offers no Safe deploy or import entry point when accounts exist', () => {
    mockUseAccounts.mockReturnValue({
      accounts: [BASE, SEPOLIA],
      loading: false,
    })

    render(<AccountsOverviewClient />)

    // The cards still render — this is a read/manage surface, not a deletion.
    expect(screen.getByRole('link', { name: 'Base account' })).toBeInTheDocument()

    // Non-vacuity (#4024): the page DOES offer a create action now, and the
    // scan below would see it — it is the delegation-rail New account, not
    // the Safe flow.
    expect(screen.getByRole('button', { name: 'New account' })).toBeInTheDocument()

    expectNoSafeInflow()
  })

  it('offers no Safe deploy or import entry point from the empty state either', () => {
    mockUseAccounts.mockReturnValue({ accounts: [], loading: false })

    render(<AccountsOverviewClient />)

    expect(screen.getByText('No Haven accounts yet')).toBeInTheDocument()
    expectNoSafeInflow()
  })
})

/**
 * #4024: the "New account" header action. It sits in `PageHeader`'s actions
 * slot (owner decision 2026-10-16, label verbatim) and opens the create
 * dialog; the dialog's flow is NewAccountDialog.test.tsx's.
 */
describe('AccountsOverviewClient — the New account action (#4024)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseAgents.mockReturnValue({ agents: [] })
    mockUsePreferences.mockReturnValue({ currency: 'USD' })
    mockUsePortfolio.mockReturnValue({ totalUsd: 0, totalEur: 0, totalSek: 0, breakdown: [], loading: false })
    mockUseAuth.mockReturnValue({ user: { accounts: [BASE, SEPOLIA] } })
  })

  it('sits in the page header and opens the New account dialog', () => {
    mockUseAccounts.mockReturnValue({ accounts: [BASE, SEPOLIA], loading: false })
    render(<AccountsOverviewClient />)

    const header = screen.getByRole('heading', { name: 'Accounts', level: 1 }).closest('header')
    expect(header).not.toBeNull()
    const action = within(header as HTMLElement).getByRole('button', { name: 'New account' })
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(action)

    expect(screen.getByRole('dialog', { name: 'New account' })).toBeInTheDocument()
  })

  it('is offered with a single account too', () => {
    mockUseAccounts.mockReturnValue({ accounts: [BASE], loading: false })
    render(<AccountsOverviewClient />)
    expect(screen.getByRole('button', { name: 'New account' })).toBeInTheDocument()
  })

  it('is hidden with no accounts: there is no passkey to create from', () => {
    mockUseAccounts.mockReturnValue({ accounts: [], loading: false })
    render(<AccountsOverviewClient />)

    // Non-vacuity: the page rendered its empty state.
    expect(screen.getByText('No Haven accounts yet')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New account' })).toBeNull()
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

/**
 * #4021 — the card cleanup and the multi-account layout.
 *
 * Part A slims the card to name, balance and one line about agents: the raw
 * `balance` rules what renders (a zero-raw token never does, even with a
 * non-zero fiat value — an unpriced holding has fiat 0), rows exist only to
 * BREAK DOWN a total, the "Added {timeAgo}" caption and the faint "Open →"
 * affordance are gone, the agent icon is the sidebar's `Bot`, the footer
 * carries the account's most recent outgoing transfer, and the network
 * marker is a "Test network" chip on testnets only (driven by the SAME
 * `isTestnetChain` predicate the Receive dialog uses — no second predicate).
 *
 * Part B: with one account the card renders wide beside a dashed "Create
 * another account" tile that opens the SAME dialog as the header action;
 * with two or more the tile is gone.
 */
describe('AccountsOverviewClient — the card cleanup and layout (#4021)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseAgents.mockReturnValue({ agents: [] })
    mockUsePreferences.mockReturnValue({ currency: 'USD' })
    mockUsePortfolio.mockReturnValue({ totalUsd: 0, totalEur: 0, totalSek: 0, breakdown: [], lastOutgoingAt: null, loading: false })
    mockUseAccounts.mockReturnValue({ accounts: [BASE, SEPOLIA], loading: false })
    mockUseAuth.mockReturnValue({ user: { accounts: [BASE, SEPOLIA] } })
  })

  const usdcHolding = { symbol: 'USDC', balance: '400000000', formatted: '400.00', usdValue: 400, eurValue: 368, sekValue: 4160 }

  it('never renders a token row whose RAW balance is zero, even when priced', () => {
    mockUsePortfolio.mockReturnValue({
      totalUsd: 433,
      totalEur: 398,
      totalSek: 4476,
      breakdown: [
        usdcHolding,
        { symbol: 'ETH', balance: '10000000000000000', formatted: '0.01', usdValue: 33, eurValue: 30, sekValue: 316 },
        // The filler shape the backend sends: raw balance zero, yet a
        // non-zero fiat value attached. Hidden — the fiat figure must never
        // resurrect a row the raw balance killed.
        { symbol: 'DAI', balance: '0', formatted: '0.00', usdValue: 50, eurValue: 46, sekValue: 520 },
      ],
      lastOutgoingAt: null,
      loading: false,
    })
    render(<AccountsOverviewClient />)

    const baseCard = getAccountCard('Base account')
    expect(within(baseCard).getByText('USDC')).toBeInTheDocument()
    expect(within(baseCard).getByText('ETH')).toBeInTheDocument()
    expect(within(baseCard).queryByText('DAI')).toBeNull()
  })

  it('renders an unpriced holding — fiat 0, raw balance non-zero', () => {
    mockUsePortfolio.mockReturnValue({
      totalUsd: 0,
      totalEur: 0,
      totalSek: 0,
      breakdown: [
        { symbol: 'USDC', balance: '400000000', formatted: '400.00', usdValue: 0, eurValue: 0, sekValue: 0 },
        { symbol: 'ETH', balance: '10000000000000000', formatted: '0.01', usdValue: 0, eurValue: 0, sekValue: 0 },
      ],
      lastOutgoingAt: null,
      loading: false,
    })
    render(<AccountsOverviewClient />)

    const baseCard = getAccountCard('Base account')
    // Both rows render: the raw balance rules, not the fiat value.
    expect(within(baseCard).getByText('USDC')).toBeInTheDocument()
    expect(within(baseCard).getByText('ETH')).toBeInTheDocument()
    expect(within(baseCard).getAllByText('$0.00').length).toBeGreaterThan(0)
  })

  it('a single non-zero token renders no rows; two render one each', () => {
    mockUsePortfolio.mockReturnValue({
      totalUsd: 400,
      totalEur: 368,
      totalSek: 4160,
      breakdown: [usdcHolding],
      lastOutgoingAt: null,
      loading: false,
    })
    const { unmount } = render(<AccountsOverviewClient />)

    const baseCard = getAccountCard('Base account')
    // One holding IS the headline — a row would repeat it.
    expect(within(baseCard).queryByText('USDC')).toBeNull()
    expect(within(baseCard).queryByText('No funds yet.')).toBeNull()
    unmount()

    mockUsePortfolio.mockReturnValue({
      totalUsd: 433,
      totalEur: 398,
      totalSek: 4476,
      breakdown: [
        usdcHolding,
        { symbol: 'ETH', balance: '10000000000000000', formatted: '0.01', usdValue: 33, eurValue: 30, sekValue: 316 },
      ],
      lastOutgoingAt: null,
      loading: false,
    })
    render(<AccountsOverviewClient />)

    const bothCard = getAccountCard('Base account')
    expect(within(bothCard).getByText('USDC')).toBeInTheDocument()
    expect(within(bothCard).getByText('ETH')).toBeInTheDocument()
  })

  it('the card has no "Added" caption and no "Open" affordance, and its agent icon is Bot', () => {
    mockUsePortfolio.mockReturnValue({
      totalUsd: 400,
      totalEur: 368,
      totalSek: 4160,
      breakdown: [usdcHolding],
      lastOutgoingAt: '2026-10-01T12:00:00.000Z',
      loading: false,
    })
    render(<AccountsOverviewClient />)

    const baseCard = getAccountCard('Base account')
    expect(within(baseCard).queryByText(/Added /)).toBeNull()
    expect(within(baseCard).queryByText(/^Open$/)).toBeNull()
    // lucide's Icon renders the svg with the icon name in its class list.
    expect(baseCard.querySelector('svg.lucide-flask-conical')).toBeNull()
    expect(baseCard.querySelector('svg.lucide-bot')).not.toBeNull()
    // The footer reads the account's most recent outgoing transfer.
    expect(within(baseCard).getByText(/Last payment /)).toBeInTheDocument()
  })

  it('the footer says "No payments yet" while the account has sent nothing', () => {
    render(<AccountsOverviewClient />)

    const baseCard = getAccountCard('Base account')
    expect(within(baseCard).getByText('No payments yet')).toBeInTheDocument()
  })

  it('mainnet cards carry no network marker; testnet cards read "Test network"', () => {
    render(<AccountsOverviewClient />)

    const baseCard = getAccountCard('Base account')
    const sepoliaCard = getAccountCard('Sepolia account')
    expect(within(baseCard).queryByText('Test network')).toBeNull()
    expect(within(baseCard).queryByText('Base')).toBeNull()
    expect(within(sepoliaCard).getByText('Test network')).toBeInTheDocument()
    expect(within(sepoliaCard).queryByText('Base Sepolia')).toBeNull()
  })

  it('an empty-balance card shows "No funds yet." with an Add funds link that opens the Receive dialog', () => {
    render(<AccountsOverviewClient />)

    const baseCard = getAccountCard('Base account')
    expect(within(baseCard).getByText('No funds yet.')).toBeInTheDocument()
    // A link, not a button — the card keeps holding no buttons (#3719). The
    // LINK keeps its task wording (owner decision on #4094); the dialog it
    // opens is the one merged Receive dialog.
    const addFunds = within(baseCard).getByRole('link', { name: 'Add funds' })
    expect(screen.queryByRole('dialog', { name: 'Receive' })).toBeNull()
    fireEvent.click(addFunds)
    expect(screen.getByRole('dialog', { name: 'Receive' })).toBeInTheDocument()
  })

  it('one account renders wide beside the create tile; two or more render no tile', () => {
    mockUseAccounts.mockReturnValue({ accounts: [BASE], loading: false })
    mockUseAuth.mockReturnValue({ user: { accounts: [BASE] } })
    const { unmount } = render(<AccountsOverviewClient />)

    expect(screen.getByRole('button', { name: /Create another account/ })).toBeInTheDocument()
    unmount()

    mockUseAccounts.mockReturnValue({ accounts: [BASE, SEPOLIA], loading: false })
    render(<AccountsOverviewClient />)

    expect(screen.queryByRole('button', { name: /Create another account/ })).toBeNull()
    // Both cards still render in the grid.
    expect(screen.getByRole('link', { name: 'Base account' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sepolia account' })).toBeInTheDocument()
  })

  it('the tile opens the same dialog as the header action', () => {
    mockUseAccounts.mockReturnValue({ accounts: [BASE], loading: false })
    mockUseAuth.mockReturnValue({ user: { accounts: [BASE] } })
    render(<AccountsOverviewClient />)

    fireEvent.click(screen.getByRole('button', { name: /Create another account/ }))
    expect(screen.getByRole('dialog', { name: 'New account' })).toBeInTheDocument()
  })

  it('the subtitle counts accounts from two, and never says "linked"', () => {
    const { unmount } = render(<AccountsOverviewClient />)

    const header = screen.getByRole('heading', { name: 'Accounts', level: 1 }).closest('header')
    expect(within(header as HTMLElement).getByText('accounts')).toBeInTheDocument()
    expect(within(header as HTMLElement).queryByText(/linked/)).toBeNull()
    unmount()

    mockUseAccounts.mockReturnValue({ accounts: [BASE], loading: false })
    render(<AccountsOverviewClient />)
    const loneHeader = screen.getByRole('heading', { name: 'Accounts', level: 1 }).closest('header')
    // Exact strings: /account/ would match the header's own "New account"
    // action. One account renders no subtitle at all.
    expect(within(loneHeader as HTMLElement).queryByText('accounts')).toBeNull()
    expect(within(loneHeader as HTMLElement).queryByText('account')).toBeNull()
    expect(within(loneHeader as HTMLElement).queryByText(/linked/)).toBeNull()
  })
})
