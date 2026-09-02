/**
 * `/custody` rail branch (#2106, epic #1440).
 *
 * The defect these tests pin is not a layout bug: on a delegation-rail account
 * the page asserted "AllowanceModule not enabled" and "No on-chain agent
 * allowances on this Safe" to a user whose agent is constrained by a signed
 * budget delegation with on-chain caveat enforcers — the inverse of the truth,
 * on the one screen whose job is proving non-custody. So the delegation-branch
 * tests are written as ABSENCE assertions on that exact copy as well as
 * presence assertions on the replacement, because a branch that renders the
 * new card AND leaves the old sentence underneath would still be lying.
 *
 * The legacy branch is asserted unchanged in the same run: it is the control,
 * and #2106's whole premise is that the page is not uniformly false.
 */

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockUseUserSafes,
  mockUseAgents,
  mockUseSafeDetails,
  mockUseDelegationCustodyProof,
  mockUseRetiredRailOwnerAccess,
} = vi.hoisted(() => ({
  mockUseUserSafes: vi.fn(),
  mockUseAgents: vi.fn(),
  mockUseSafeDetails: vi.fn(),
  mockUseDelegationCustodyProof: vi.fn(),
  mockUseRetiredRailOwnerAccess: vi.fn(),
}))

vi.mock('@/hooks/useUserSafes', () => ({ useUserSafes: () => mockUseUserSafes() }))
vi.mock('@/hooks/useAgents', () => ({ useAgents: () => mockUseAgents() }))
vi.mock('@/hooks/useSafeDetails', () => ({ useSafeDetails: () => mockUseSafeDetails() }))
vi.mock('@/hooks/useDelegationCustodyProof', () => ({
  useDelegationCustodyProof: () => mockUseDelegationCustodyProof(),
}))
vi.mock('@/hooks/useRetiredRailOwnerAccess', () => ({
  useRetiredRailOwnerAccess: (...args: unknown[]) => mockUseRetiredRailOwnerAccess(...args),
}))

import CustodyPage from '../page'
// Not from '../page': Next refuses arbitrary named exports from a page
// module, so these live in `lib/custody-rail.ts` (#2106 — `next build`
// caught it; `tsc --noEmit` did not).
import { havenCannotLines, railOf } from '@/lib/custody-rail'

const CHAIN_ID = 84532
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const MERCHANT = '0x9f8f72aA9304c8B593d555F12eF6589cC3A579A2'
const DELEGATE = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'

function safe(accountType: string | null) {
  return {
    id: 'safe-1',
    safe_address: '0x1111111111111111111111111111111111111111',
    chain_id: CHAIN_ID,
    name: 'Operating wallet',
    is_default: true,
    created_at: '2026-05-01T10:00:00.000Z',
    account_type: accountType,
  }
}

const AGENT = {
  id: 'agent-research',
  name: 'Research agent',
  safe_id: 'safe-1',
  delegate_address: DELEGATE,
}

const ACTIVE_BUDGET = {
  id: 'dlg-1',
  token_address: USDC,
  recipient_address: MERCHANT,
  delegation_hash: `0x${'4d'.repeat(32)}`,
  version: 1,
  status: 'active' as const,
  budget_atomic: '250000000',
  period_seconds: 604_800,
  expires_at: Math.floor(Date.UTC(2027, 5, 2) / 1000),
}

/** The two sentences #2106 exists to stop reaching a delegation-rail user. */
beforeEach(() => {
  vi.clearAllMocks()
  mockUseAgents.mockReturnValue({ agents: [AGENT] })
  mockUseSafeDetails.mockReturnValue({
    details: { address: safe(null).safe_address, owners: [DELEGATE, MERCHANT], threshold: 2, nonce: 3 },
    loading: false,
    error: null,
    refetch: vi.fn(),
  })
  mockUseRetiredRailOwnerAccess.mockReturnValue({
    ...mockUseSafeDetails(),
    ownerAccess: 'unknown',
  })
  mockUseDelegationCustodyProof.mockReturnValue({
    signers: {
      account_address: safe(null).safe_address,
      chain_id: CHAIN_ID,
      owner_address: null,
      passkeys: [{ key_id: `0x${'11'.repeat(32)}`, x: '0x1', y: '0x2', created_at: null }],
    },
    signersLoading: false,
    budgetsByAgent: new Map([[AGENT.id, [ACTIVE_BUDGET]]]),
    budgetsLoading: false,
    budgetsError: false,
    reloadBudgets: vi.fn(),
  })
})

describe('/custody — delegation rail (#2106)', () => {
  beforeEach(() => {
    mockUseUserSafes.mockReturnValue({ safes: [safe('delegator_hybrid')], loading: false })
  })

  it('does NOT render the AllowanceModule copy', () => {
    render(<CustodyPage />)
    expect(screen.queryByText(/AllowanceModule/)).toBeNull()
  })

  it('does NOT render the "no on-chain agent allowances" copy', () => {
    render(<CustodyPage />)
    expect(screen.queryByText(/on-chain agent allowances/)).toBeNull()
  })

  it('renders the signed budget delegation as the spend control', () => {
    render(<CustodyPage />)
    expect(screen.getByText(/Signed budget delegation/)).toBeTruthy()
  })

  it('renders the delegation budget, its period and its expiry', () => {
    const { container } = render(<CustodyPage />)
    const text = container.textContent ?? ''
    expect(text).toContain('Research agent')
    expect(text).toContain('250')
    expect(text).toContain('per week')
    expect(text).toContain('2027')
  })

  it('presents the pinned recipient as on-chain enforced, not as advisory', () => {
    const { container } = render(<CustodyPage />)
    const text = container.textContent ?? ''
    // The old page said the recipient was "ⓘ not on-chain" constrained. On
    // this rail the pin IS a caveat enforcer.
    expect(text).not.toContain('ⓘ not on-chain')
    expect(text).toContain('🔒 on-chain')
  })

  it('does not offer a Safe{Wallet} deep link for an account Safe{Wallet} cannot open', () => {
    const { container } = render(<CustodyPage />)
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '')
    expect(hrefs.some((h) => h.includes('app.safe.global'))).toBe(false)
    expect(hrefs.some((h) => h.includes('/address/'))).toBe(true)
  })

  it('shows the account signer set rather than Safe owners', () => {
    const { container } = render(<CustodyPage />)
    const text = container.textContent ?? ''
    expect(text).toContain('Signers (control this account — Haven is not one)')
    expect(text).not.toContain('Owners (control this Safe — Haven is not one)')
  })
})

/**
 * #2106 review finding. A failed delegation read used to be stored as an empty
 * array, which the card rendered as "No agent budget granted on this account."
 * — an affirmative claim that the agent has no on-chain limit. That is the SAME
 * defect this issue exists to close, reached from the other direction, so the
 * unknown state has to stay distinguishable from the empty one.
 */
describe('/custody — a failed delegation read is never "no budget" (#2106)', () => {
  beforeEach(() => {
    mockUseUserSafes.mockReturnValue({ safes: [safe('delegator_hybrid')], loading: false })
    mockUseDelegationCustodyProof.mockReturnValue({
      signers: null,
      signersLoading: false,
      budgetsByAgent: new Map(),
      budgetsLoading: false,
      budgetsError: true,
      reloadBudgets: vi.fn(),
    })
  })

  it('does not claim the account has no budget', () => {
    const { container } = render(<CustodyPage />)
    expect(container.textContent ?? '').not.toContain('No agent budget granted')
  })

  it('says the read failed, and says it is not a statement about existence', () => {
    const { container } = render(<CustodyPage />)
    const text = container.textContent ?? ''
    expect(text).toContain('could not load')
    expect(text).toContain('not a statement that none exist')
  })

  it('offers a retry — a failed proof must not be a dead end', () => {
    render(<CustodyPage />)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('does not assert on-chain spend control it could not read', () => {
    const { container } = render(<CustodyPage />)
    expect(container.textContent ?? '').not.toContain('Signed budget delegation')
  })
})

/**
 * #2106 review finding. Nothing flips `agent_delegations.status` on expiry —
 * it only moves pending → active → replaced/revoked — so an expired delegation
 * still reads 'active'. Its TimestampEnforcer rejects it on-chain, so
 * summarising it as live spend control would be a false custody claim.
 */
describe('/custody — an expired delegation is not live spend control (#2106)', () => {
  const EXPIRED = {
    ...ACTIVE_BUDGET,
    delegation_hash: `0x${'7f'.repeat(32)}`,
    expires_at: Math.floor(Date.UTC(2020, 0, 1) / 1000),
  }

  beforeEach(() => {
    mockUseUserSafes.mockReturnValue({ safes: [safe('delegator_hybrid')], loading: false })
    mockUseDelegationCustodyProof.mockReturnValue({
      signers: null,
      signersLoading: false,
      budgetsByAgent: new Map([[AGENT.id, [EXPIRED]]]),
      budgetsLoading: false,
      budgetsError: false,
      reloadBudgets: vi.fn(),
    })
  })

  it('does not summarise an expired delegation as live spend control', () => {
    const { container } = render(<CustodyPage />)
    expect(container.textContent ?? '').not.toContain('Signed budget delegation')
  })

  it('still lists the row, tagged expired — hiding it would be its own dishonesty', () => {
    const { container } = render(<CustodyPage />)
    const text = container.textContent ?? ''
    expect(text).toContain('Research agent')
    expect(text).toContain('expired')
  })

  it('a delegation still inside its window IS live spend control', () => {
    mockUseDelegationCustodyProof.mockReturnValue({
      signers: null,
      signersLoading: false,
      budgetsByAgent: new Map([[AGENT.id, [ACTIVE_BUDGET]]]),
      budgetsLoading: false,
      budgetsError: false,
      reloadBudgets: vi.fn(),
    })
    const { container } = render(<CustodyPage />)
    const text = container.textContent ?? ''
    expect(text).toContain('Signed budget delegation')
    expect(text).not.toContain('expired')
  })
})

describe('/custody — legacy Safe rail is unchanged (#2106 control)', () => {
  beforeEach(() => {
    mockUseUserSafes.mockReturnValue({ safes: [safe(null)], loading: false })
  })

  it('still renders the owners/threshold proof', () => {
    const { container } = render(<CustodyPage />)
    const text = container.textContent ?? ''
    expect(text).toContain('Owners (control this Safe — Haven is not one)')
    expect(text).toContain('Threshold: 2 of 2')
  })

  it('keeps legacy account reads while retiring the agent spending surface', () => {
    render(<CustodyPage />)
    expect(screen.getByText('Haven no longer sends payments from this account.')).toBeTruthy()
    expect(screen.queryByText(/AllowanceModule/)).toBeNull()
    expect(screen.queryByText(/on-chain agent allowances/)).toBeNull()
  })

  it('still offers the Safe{Wallet} deep link', () => {
    mockUseRetiredRailOwnerAccess.mockReturnValue({
      ...mockUseSafeDetails(),
      ownerAccess: 'wallet',
    })
    const { container } = render(<CustodyPage />)
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '')
    expect(hrefs).toContain(
      `https://app.safe.global/home?safe=basesep:${safe(null).safe_address}`,
    )
  })

  it('does not offer Safe{Wallet} to an unknown or passkey-only owner', () => {
    for (const ownerAccess of ['unknown', 'passkey-only'] as const) {
      mockUseRetiredRailOwnerAccess.mockReturnValue({
        ...mockUseSafeDetails(),
        ownerAccess,
      })
      const { container, unmount } = render(<CustodyPage />)
      const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '')
      expect(hrefs.some((h) => h.includes('app.safe.global'))).toBe(false)
      unmount()
    }
  })

  it('does not present the retired rail as an active spending control', () => {
    const { container } = render(<CustodyPage />)
    expect(container.textContent ?? '').toContain('Legacy agent spending is retired in Haven')
  })
})

describe('railOf (#1069 rail marker)', () => {
  it('reads delegator_hybrid as the delegation rail', () => {
    expect(railOf({ account_type: 'delegator_hybrid' })).toBe('delegation')
  })

  it('reads null and the legacy marker as the Safe rail — no third state', () => {
    expect(railOf({ account_type: null })).toBe('safe')
    expect(railOf({ account_type: 'safe' })).toBe('safe')
    expect(railOf({ account_type: undefined })).toBe('safe')
  })
})

describe('"What Haven cannot do" is rail-correct (#2106)', () => {
  const SAFE_TX_CLAIM = 'without a Safe transaction you sign'
  const SAFE_APP_CLAIM = 'any Safe-compatible app'

  it('never tells a delegation-rail user their authority is a Safe transaction', () => {
    const lines = havenCannotLines([{ account_type: 'delegator_hybrid' }]).join(' ')
    expect(lines).not.toContain(SAFE_TX_CLAIM)
    expect(lines).not.toContain(SAFE_APP_CLAIM)
    expect(lines).toContain('without a new delegation you sign')
  })

  it('keeps the Safe-rail wording for a Safe-rail user', () => {
    const lines = havenCannotLines([{ account_type: null }]).join(' ')
    expect(lines).toContain(SAFE_TX_CLAIM)
    expect(lines).toContain('supported Safe owner')
    expect(lines).not.toContain(SAFE_APP_CLAIM)
  })

  it('keeps the two rail-independent claims on both rails', () => {
    for (const accountType of ['delegator_hybrid', null]) {
      const lines = havenCannotLines([{ account_type: accountType }]).join(' ')
      expect(lines).toContain('Move your funds')
      expect(lines).toContain('Hold your keys')
    }
  })

  it('labels both variants when the user holds accounts on both rails', () => {
    const lines = havenCannotLines([
      { account_type: 'delegator_hybrid' },
      { account_type: null },
    ])
    expect(lines.some((l) => l.startsWith('On your Haven account: '))).toBe(true)
    expect(lines.some((l) => l.startsWith('On your legacy Safe: '))).toBe(true)
  })

  it('falls to the delegation rail with no accounts — the only rail #1984 leaves open', () => {
    const lines = havenCannotLines([]).join(' ')
    expect(lines).toContain('without a new delegation you sign')
    expect(lines).not.toContain(SAFE_TX_CLAIM)
  })
})
