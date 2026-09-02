import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockUseAuth,
  mockUseUserSafes,
  mockUseAgents,
  mockUsePreferences,
  mockSetActiveSafe,
} = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockUseUserSafes: vi.fn(),
  mockUseAgents: vi.fn(),
  mockUsePreferences: vi.fn(),
  mockSetActiveSafe: vi.fn(),
}))

vi.mock('@/context/AuthContext', () => ({ useAuth: () => mockUseAuth() }))
vi.mock('@/hooks/useUserSafes', () => ({ useUserSafes: () => mockUseUserSafes() }))
vi.mock('@/hooks/useAgents', () => ({ useAgents: () => mockUseAgents() }))
vi.mock('@/hooks/usePreferences', () => ({ usePreferences: () => mockUsePreferences() }))
vi.mock('@/hooks/usePortfolio', () => ({
  usePortfolio: () => ({ totalUsd: 0, totalEur: 0, breakdown: [], loading: false }),
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

function safe(id: string, name: string, chainId: number, isDefault = false) {
  return {
    id,
    safe_address: `0x${id.padEnd(40, '0')}`,
    chain_id: chainId,
    name,
    is_default: isDefault,
    created_at: '2026-06-01T00:00:00Z',
  }
}

const BASE = safe('base1', 'Base account', 8453, true)
const SEPOLIA = safe('sep1', 'Sepolia account', 84532)

describe('AccountsOverviewClient — active account (#629)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseAgents.mockReturnValue({ agents: [] })
    mockUsePreferences.mockReturnValue({ currency: 'USD' })
    mockUseUserSafes.mockReturnValue({
      safes: [BASE, SEPOLIA],
      loading: false,
    })
    mockUseAuth.mockReturnValue({ activeSafe: BASE, setActiveSafe: mockSetActiveSafe })
  })

  it('marks the active account and offers Set active only on the others', () => {
    render(<AccountsOverviewClient />)

    const activeCard = screen.getByLabelText('Base account')
    expect(within(activeCard).getByText('Active')).toBeInTheDocument()
    // The active card has no "set active" affordance.
    expect(within(activeCard).queryByLabelText(/Set Base account as active/)).toBeNull()

    // The other card offers a switch.
    expect(screen.getByLabelText('Set Sepolia account as active')).toBeInTheDocument()
  })

  it('switches the active account via Set active without navigating', () => {
    render(<AccountsOverviewClient />)

    fireEvent.click(screen.getByLabelText('Set Sepolia account as active'))
    expect(mockSetActiveSafe).toHaveBeenCalledWith(SEPOLIA)
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
    mockUseAuth.mockReturnValue({ activeSafe: BASE, setActiveSafe: mockSetActiveSafe })
  })

  it('offers no Add-account entry point when accounts exist', () => {
    mockUseUserSafes.mockReturnValue({
      safes: [BASE, SEPOLIA],
      loading: false,
    })

    render(<AccountsOverviewClient />)

    // The cards still render — this is a read/manage surface, not a deletion.
    expect(screen.getByLabelText('Base account')).toBeInTheDocument()

    expect(screen.queryByRole('button', { name: /add account/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /add your first account/i })).toBeNull()
    expect(screen.queryByText('Import existing account')).toBeNull()
    expect(screen.queryByText('Create Haven account')).toBeNull()
  })

  it('offers no Add-account entry point from the empty state either', () => {
    mockUseUserSafes.mockReturnValue({ safes: [], loading: false })

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
 *     control that is meant to survive ("Set active") IS found, before
 *     asserting anything is missing. A component that threw would otherwise
 *     read as a clean removal.
 *  2. **Both spellings.** The scan matches any control whose accessible name
 *     or visible text mentions "default", not the star's old exact label — so
 *     it also fails on the labelled `Set default` variant the decision
 *     rejected, and on a kebab item added to the card later.
 *  3. **The state where it mattered most gets its own case.** A single
 *     NON-default account: both badges are gated on `safes.length > 1`, so the
 *     word `default` renders nowhere on the page, and `/accounts/<id>` hides
 *     its own set-default action in exactly this state — while the card's star
 *     was gated on `!safe.is_default` alone and rendered anyway.
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
    mockUseAuth.mockReturnValue({ activeSafe: BASE, setActiveSafe: mockSetActiveSafe })
  })

  /** Every control on the page whose accessible name or text mentions the word. */
  function controlsMentioning(word: RegExp): string[] {
    return screen
      .queryAllByRole('button')
      .map((el) => `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''}`.trim())
      .filter((n) => word.test(n))
  }

  it('offers no set-default control with several accounts, while keeping the default badge', () => {
    mockUseUserSafes.mockReturnValue({ safes: [BASE, SEPOLIA], loading: false })

    render(<AccountsOverviewClient />)

    // Non-vacuity: the cards rendered, and the surviving action is present.
    expect(screen.getByLabelText('Base account')).toBeInTheDocument()
    // `.some(includes)` rather than `toContain`: the scan concatenates the
    // accessible name with the visible text, so the entry reads
    // "Set Sepolia account as active Set active" and an exact match would be
    // asserting the concatenation format instead of the control's presence.
    expect(
      controlsMentioning(/active/i).some((n) => n.includes('Set Sepolia account as active')),
      `the surviving set-active control was not found — the scan saw ${JSON.stringify(controlsMentioning(/active/i))}`,
    ).toBe(true)

    expect(controlsMentioning(/default/i)).toEqual([])
    expect(screen.queryByLabelText(/set .* as default/i)).toBeNull()

    // The chip that NAMES the default account stays — only the control that
    // set it from the card is gone. BASE is the default of two accounts, so
    // `showDefaultBadge` is satisfied.
    expect(within(screen.getByLabelText('Base account')).getByText('default')).toBeInTheDocument()
  })

  it('offers no set-default control for a lone NON-default account either', () => {
    const LONE = safe('lone1', 'Lone account', 8453, false)
    mockUseUserSafes.mockReturnValue({ safes: [LONE], loading: false })
    mockUseAuth.mockReturnValue({ activeSafe: LONE, setActiveSafe: mockSetActiveSafe })

    render(<AccountsOverviewClient />)

    // Non-vacuity: the card is there under its own name.
    expect(screen.getByLabelText('Lone account')).toBeInTheDocument()

    // The state the star was worst in: no badge says "default" anywhere, the
    // detail page hides the same action here, and the star rendered anyway.
    expect(screen.queryByText('default')).toBeNull()
    expect(controlsMentioning(/default/i)).toEqual([])
  })
})
