import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiOperations } from '@haven_ai/core'
import type { Agent } from '@/hooks/useAgents'
import type { CatalogEntry, Merchant, MerchantFundingTarget } from '@/hooks/useCatalog'
import type { DelegationBudget } from '@/hooks/useDelegationBudget'

const { mockGrant, mockReady, mockBudgets, mockBudgetsError, mockReload } = vi.hoisted(() => ({
  mockGrant: vi.fn(),
  mockReady: vi.fn(() => true),
  mockBudgets: vi.fn((): unknown[] | null => []),
  mockBudgetsError: vi.fn(() => false),
  mockReload: vi.fn(),
}))

vi.mock('@/hooks/useDelegationBudget', () => ({
  useDelegationBudget: () => ({
    budgets: mockBudgets(),
    budgetsError: mockBudgetsError(),
    reload: mockReload,
    grant: mockGrant,
    busy: false,
    ready: mockReady(),
  }),
}))

const FundMerchantModal = (await import('../FundMerchantModal')).default
const { eligibleFundingAgents, merchantTokenOptions } = await import('../FundMerchantModal')

const USDC_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const PAY_TO = '0x' + 'f0'.repeat(20)

const merchant: Merchant = {
  id: 'merchant-1',
  slug: 'ampersend-demo-api',
  name: 'Ampersend Demo API',
  description: 'Fact, joke and quote endpoints.',
  website: 'https://app.ampersend.ai',
  logo_url: null,
  category: 'api',
  country: null,
  listing_status: 'live',
  is_test_merchant: false,
  offer_count: 1,
  networks: ['eip155:84532'],
  verified_payable: true,
}

const funding: MerchantFundingTarget[] = [
  { network: 'eip155:84532', chain_id: 84532, pay_to: PAY_TO, pay_to_status: 'verified', erc7710: true },
]

function offer(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'offer-1',
    name: 'Joke',
    description: 'Returns a joke.',
    category: 'api',
    resource_url: 'https://services.sandbox.ampersend.ai/api/joke',
    merchant: { id: merchant.id, slug: merchant.slug, name: merchant.name, listing_status: 'live', is_test_merchant: false },
    rail: 'x402',
    protocol: 'http',
    tool_name: null,
    tool_arguments: null,
    price_display: '$0.001 USDC',
    price_atomic: '1000',
    asset: 'USDC',
    network: 'eip155:84532',
    asset_transfer_methods: 'erc7710',
    status: 'active',
    verified_at: new Date().toISOString(),
    source: 'operator',
    domain_verified: false,
    verified_payable: true,
    ...overrides,
  }
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Research Agent',
    description: null,
    delegate_address: '0x' + 'de'.repeat(20),
    account_id: 'acc-1',
    account_address: '0x' + 'aa'.repeat(20),
    account_name: 'Haven wallet',
    account_chain_id: 84532,
    account_type: 'delegator_hybrid',
    api_key_prefix: 'hv_abc',
    status: 'active',
    created_at: new Date().toISOString(),
    allowances: [],
    labels: [],
    organization_id: null,
    ...overrides,
  } as Agent
}

function budget(overrides: Partial<DelegationBudget> = {}): DelegationBudget {
  return {
    id: 'b1',
    token_address: USDC_SEPOLIA,
    recipient_address: PAY_TO,
    delegation_hash: '0x' + 'ab'.repeat(32),
    version: 1,
    status: 'active',
    budget_atomic: '5000000',
    period_seconds: 86_400,
    expires_at: 9_999_999_999,
    merchant_id: null,
    merchant_slug: null,
    merchant_name: null,
    ...overrides,
  }
}

const PROPS = {
  open: true,
  onClose: vi.fn(),
  merchant,
  funding,
  offers: [offer()],
  agents: [agent()],
}

beforeEach(() => {
  mockGrant.mockReset()
  mockGrant.mockResolvedValue({ ok: true })
  mockReady.mockReset()
  mockReady.mockReturnValue(true)
  mockBudgets.mockReset()
  mockBudgets.mockReturnValue([])
  mockBudgetsError.mockReset()
  mockBudgetsError.mockReturnValue(false)
  mockReload.mockReset()
  PROPS.onClose = vi.fn()
})

describe('eligibleFundingAgents (#3331)', () => {
  it('includes an agent only when its chain has a verified, ERC-7710 funding target', () => {
    expect(eligibleFundingAgents([agent()], funding)).toHaveLength(1)
    expect(eligibleFundingAgents([agent({ account_chain_id: 8453 })], funding)).toHaveLength(0)
    expect(
      eligibleFundingAgents(
        [agent()],
        [{ network: 'eip155:84532', chain_id: 84532, pay_to: PAY_TO, pay_to_status: 'verified', erc7710: false }],
      ),
    ).toHaveLength(0)
    expect(
      eligibleFundingAgents(
        [agent()],
        [{ network: 'eip155:84532', chain_id: 84532, pay_to: null, pay_to_status: 'unstated', erc7710: false }],
      ),
    ).toHaveLength(0)
  })

  it.each(['shared', 'conflicting', 'unstated'] as const)(
    'excludes a %s payTo even when every offer is ERC-7710 — only a verified one can be pinned',
    (status) => {
      expect(
        eligibleFundingAgents(
          [agent()],
          [{ network: 'eip155:84532', chain_id: 84532, pay_to: null, pay_to_status: status, erc7710: true }],
        ),
      ).toHaveLength(0)
    },
  )

  it('excludes a revoked agent or one with no linked chain', () => {
    expect(eligibleFundingAgents([agent({ status: 'revoked' })], funding)).toHaveLength(0)
    expect(eligibleFundingAgents([agent({ account_chain_id: null })], funding)).toHaveLength(0)
  })

  // #3331 review finding F8: this mutation (dropping `|| agent.archived_at`)
  // survived — an archived-but-not-`revoked` agent must still be excluded.
  it('excludes an archived agent even when its status is not revoked', () => {
    expect(
      eligibleFundingAgents([agent({ status: 'active', archived_at: '2026-01-01T00:00:00.000Z' })], funding),
    ).toHaveLength(0)
  })
})

describe('merchantTokenOptions (#3331)', () => {
  it('resolves the ERC-7710 offer asset through the chain registry', () => {
    const options = merchantTokenOptions(84532, [offer()])
    expect(options).toEqual([{ address: USDC_SEPOLIA, symbol: 'USDC', decimals: 6 }])
  })

  it('excludes an offer that does not advertise ERC-7710', () => {
    expect(merchantTokenOptions(84532, [offer({ asset_transfer_methods: null })])).toEqual([])
  })

  it('excludes an offer on a different chain', () => {
    expect(merchantTokenOptions(8453, [offer()])).toEqual([])
  })
})

describe('FundMerchantModal (#3331)', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<FundMerchantModal {...PROPS} open={false} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows a no-eligible-agent message when none of the agents qualify, with a way out and no dead Review button', () => {
    const { container } = render(<FundMerchantModal {...PROPS} agents={[agent({ account_chain_id: 8453 })]} />)
    expect(screen.getByText(/None of your agents can be pinned to Ampersend Demo API yet/)).toBeDefined()
    expect(screen.queryByLabelText('Agent')).toBeNull()
    // #3331 review finding F6/design-3: a link to connect/set up an agent,
    // and only a Close button — never a disabled Review with nothing to review.
    expect(screen.getByRole('link', { name: 'Connect or set up an agent' }).getAttribute('href')).toBe('/agents')
    // The header's icon-only close button ALSO carries the accessible name
    // "Close" (its `aria-label`) — this asserts the visible footer button by
    // its text node, not the (also-present) header one.
    expect(screen.getByText('Close').closest('button')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull()
    // #3331 review-caught bug: an expression immediately after a LINE BREAK in
    // JSX text collapses to no space at all ("networkAmpersend Demo API…") —
    // pin the properly spaced sentence, read off the full rendered text, so a
    // regression shows as a text miss rather than a passing squashed string.
    expect(container.textContent).toContain('on a network Ampersend Demo API accepts, then come back here.')
  })

  it('lists only eligible agents in the picker', () => {
    render(<FundMerchantModal {...PROPS} agents={[agent(), agent({ id: 'agent-2', name: 'Other', account_chain_id: 8453 })]} />)
    const select = screen.getByLabelText('Agent') as HTMLSelectElement
    const options = Array.from(select.options).map((o) => o.textContent)
    expect(options).toEqual(['Research Agent'])
  })

  it('states which budget pays and never lets the recipient be edited', () => {
    render(<FundMerchantModal {...PROPS} />)
    expect(screen.getByText(/Pays only Ampersend Demo API/)).toBeDefined()
    expect(screen.queryByLabelText('Recipient')).toBeNull()
    expect(screen.queryByLabelText('Recipient address')).toBeNull()
  })

  it('review step: warns before signing when the agent already has an active PLAIN budget in the same slot', async () => {
    mockBudgets.mockReturnValue([budget({ merchant_id: null, recipient_address: PAY_TO, token_address: USDC_SEPOLIA })])
    render(<FundMerchantModal {...PROPS} />)
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign budget' })).toBeDefined())
    expect(screen.getByText(/replaces this agent's current budget to the same address/)).toBeDefined()
  })

  it('review step: warns with merchant-specific copy when the agent already has a budget locked to THIS merchant', async () => {
    mockBudgets.mockReturnValue([budget({ merchant_id: merchant.id, recipient_address: PAY_TO, token_address: USDC_SEPOLIA })])
    render(<FundMerchantModal {...PROPS} />)
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() =>
      expect(screen.getByText(new RegExp(`replaces this agent's current budget for ${merchant.name}`))).toBeDefined(),
    )
  })

  it('review step: no warning for a budget for this merchant in ANOTHER slot (stale payTo) — it is not replaced', async () => {
    mockBudgets.mockReturnValue([
      budget({ merchant_id: merchant.id, recipient_address: '0x' + '99'.repeat(20), token_address: USDC_SEPOLIA }),
    ])
    render(<FundMerchantModal {...PROPS} />)
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign budget' })).toBeDefined())
    expect(screen.queryByText(/replaces/)).toBeNull()
  })

  // #3331 review finding F8: this mutation (dropping the TOKEN match from the
  // replace predicate) survived — an active row at the same recipient but a
  // DIFFERENT token is a different slot and must not warn.
  it('review step: no warning for a budget at the same recipient but a DIFFERENT token', async () => {
    mockBudgets.mockReturnValue([
      budget({ merchant_id: null, recipient_address: PAY_TO, token_address: '0x' + '77'.repeat(20) }),
    ])
    render(<FundMerchantModal {...PROPS} />)
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign budget' })).toBeDefined())
    expect(screen.queryByText(/replaces/)).toBeNull()
  })

  // #3331 review finding F8: this mutation (dropping the `status === 'active'`
  // check) survived — a REVOKED row in the same (token, recipient) slot is
  // not live and must not warn either.
  it('review step: no warning for a revoked (inactive) budget in the same slot', async () => {
    mockBudgets.mockReturnValue([
      budget({ merchant_id: null, recipient_address: PAY_TO, token_address: USDC_SEPOLIA, status: 'revoked' }),
    ])
    render(<FundMerchantModal {...PROPS} />)
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign budget' })).toBeDefined())
    expect(screen.queryByText(/replaces/)).toBeNull()
  })

  // #3331 review finding F8: the replace-predicate gap — an active row in the
  // SAME (token, recipient) slot but locked to a DIFFERENT merchant used to
  // match neither the "plain" nor the "this merchant" predicate. It IS in the
  // same slot (one address, one slot — docs/product/marketplace.md) and IS
  // replaced; the copy just names the other merchant.
  it("review step: warns and names the OTHER merchant when the slot is locked to a different merchant", async () => {
    mockBudgets.mockReturnValue([
      budget({
        merchant_id: 'merchant-2',
        merchant_name: 'Other Merchant',
        recipient_address: PAY_TO,
        token_address: USDC_SEPOLIA,
      }),
    ])
    render(<FundMerchantModal {...PROPS} />)
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() =>
      expect(
        screen.getByText(/replaces this agent's current budget for Other Merchant, which uses the same payment address/),
      ).toBeDefined(),
    )
  })

  it('review step: no warning with no conflicting active budget', async () => {
    mockBudgets.mockReturnValue([])
    render(<FundMerchantModal {...PROPS} />)
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign budget' })).toBeDefined())
    expect(screen.queryByText(/replaces/)).toBeNull()
  })

  it('review step: states the no-fallback rule and BOTH exceptions while this budget is active (#3331 F2, corrected round 3 captain copy)', async () => {
    render(<FundMerchantModal {...PROPS} />)
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() =>
      expect(
        screen.getByText(/Payments this agent sends straight to Ampersend Demo API use this budget\. Once it runs out, those payments are refused until the next period/),
      ).toBeDefined(),
    )
    expect(
      screen.getByText(/checkout payments that pass through the agent first still use its open budget, and a task budget pays from whichever budget it was set up from/),
    ).toBeDefined()
    expect(screen.queryByText(/preferred/)).toBeNull()
    // No jargon: never "delegation", "caveat", "recipient pin", "ERC-7710",
    // "EIP-3009" or "task budget ID" in the review-step copy shown to the owner.
    expect(screen.queryByText(/delegation|caveat|recipient pin|erc-?7710|eip-?3009/i)).toBeNull()
  })

  it('review step: renders the SIGNED amount (formatUnits of the atomic value), not the typed string (#3331 F5)', async () => {
    render(<FundMerchantModal {...PROPS} />)
    // Trailing zero the typed string carries but the atomic round-trip drops.
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '5.10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => expect(screen.getByText(/5\.1 USDC per month/)).toBeDefined())
    expect(screen.queryByText(/5\.10 USDC/)).toBeNull()
  })

  it('rejects scientific notation with a message instead of silently disabling Review (#3331 F5)', () => {
    render(<FundMerchantModal {...PROPS} />)
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '1e3' } })
    expect(screen.getByText(/Enter a plain number/)).toBeDefined()
    expect((screen.getByRole('button', { name: 'Review' }) as HTMLButtonElement).disabled).toBe(true)
  })

  // ── design review round 2, finding 7 ────────────────────────────────────
  it('links the amount error to the input via aria-describedby and announces it', () => {
    render(<FundMerchantModal {...PROPS} />)
    const input = screen.getByLabelText('Budget amount')
    expect(input.getAttribute('aria-describedby')).toBeNull()
    fireEvent.change(input, { target: { value: '1e3' } })
    const error = screen.getByText(/Enter a plain number/)
    expect(error.id).toBe('fund-merchant-amount-error')
    expect(error.getAttribute('role')).toBe('alert')
    expect(input.getAttribute('aria-describedby')).toBe('fund-merchant-amount-error')
  })

  it('rejects more fraction digits than the token supports, by name (#3331 F5)', () => {
    render(<FundMerchantModal {...PROPS} />)
    // USDC_SEPOLIA has 6 decimals.
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '1.1234567' } })
    expect(screen.getByText(/USDC supports up to 6 decimal places/)).toBeDefined()
  })

  it('rejects a zero amount', () => {
    render(<FundMerchantModal {...PROPS} />)
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '0' } })
    expect((screen.getByRole('button', { name: 'Review' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('signs via grant() with merchantSlug AND the displayed payTo as recipientAddress (#3331 F1, WYSIWYS)', async () => {
    const onGranted = vi.fn()
    render(<FundMerchantModal {...PROPS} onGranted={onGranted} />)
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => screen.getByRole('button', { name: 'Sign budget' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign budget' }))
    await waitFor(() => expect(screen.getByText('Budget set')).toBeDefined())
    expect(mockGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenAddress: USDC_SEPOLIA,
        recipientAddress: PAY_TO,
        budgetAtomic: '5000000',
        periodSeconds: 2_592_000,
        merchantSlug: 'ampersend-demo-api',
      }),
    )
    expect(onGranted).toHaveBeenCalled()
  })

  it('Review stays disabled while this agent\'s existing budgets are still unknown, and a retry surfaces on failure (#3331 F4)', () => {
    mockBudgets.mockReturnValue(null)
    mockBudgetsError.mockReturnValue(true)
    render(<FundMerchantModal {...PROPS} />)
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '5' } })
    expect((screen.getByRole('button', { name: 'Review' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/Haven could not check this agent's existing budgets/)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(mockReload).toHaveBeenCalled()
  })

  // ── error mapping of the 409s (#3331) ──────────────────────────────────
  const CASES: Array<[string, RegExp]> = [
    [
      'Merchant has no verified payTo on this chain; a merchant-locked budget cannot be issued yet',
      /hasn't confirmed where it is paid on this network yet/,
    ],
    [
      'Merchant does not accept ERC-7710 payments on this chain; its payments use the open budget',
      /open budget instead/,
    ],
    [
      "Merchant's payTo is one of this agent's own addresses; a merchant-locked budget cannot be issued to it",
      /this agent's own wallet/,
    ],
    [
      "recipient_address does not match the merchant's current verified payTo; reload the merchant page",
      /payment address changed/,
    ],
    // #3331 review finding F9: the build refusals that are NOT specific to the
    // merchant-locked path (any grant caller can hit these) get their own
    // plain sentence too, rather than the backend's raw message.
    ['Revoked agents cannot receive new budget delegations', /was revoked and cannot receive/],
    [
      'A key rotation is in flight for this agent — finish or abandon the re-key before granting a new budget',
      /key change.*already in progress/,
    ],
    ['Agent cannot receive a budget while its account or re-key is unavailable', /temporarily unavailable/],
    ['Delegation rail not enabled on chain 8453', /cannot receive this kind of budget/],
  ]

  it.each(CASES)('maps the %s refusal to its own copy, always closing with "Nothing changed."', async (detail, expected) => {
    mockGrant.mockResolvedValue({ ok: false, reason: 'refused', detail })
    render(<FundMerchantModal {...PROPS} />)
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => screen.getByRole('button', { name: 'Sign budget' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign budget' }))
    await waitFor(() => expect(screen.getByText('The budget could not be set')).toBeDefined())
    expect(screen.getByText(expected)).toBeDefined()
    expect(screen.getByText(/Nothing changed\.$/)).toBeDefined()
    // Never the backend's raw sentence verbatim.
    expect(screen.queryByText(detail)).toBeNull()
    // No jargon anywhere in the error-state copy (doc review 3).
    expect(screen.queryByText(/delegation|caveat|recipient pin|erc-?7710|eip-?3009/i)).toBeNull()
  })

  // ── design review round 2, finding 2 / round 3 finding A (code F2):
  // permanent refusals drop "Try again", and every refusal a page reload CAN
  // fix — the payTo moved, it isn't confirmed yet, or the merchant vanished —
  // offers "Reload page" rather than a bare "Close".
  it.each([
    [
      "recipient_address does not match the merchant's current verified payTo; reload the merchant page",
      'pay_to_changed',
    ],
    [
      'Merchant has no verified payTo on this chain; a merchant-locked budget cannot be issued yet',
      'no_verified_pay_to',
    ],
    ['merchant not found', 'merchant_not_found'],
  ])('a %s refusal offers "Reload page" as the sole action, never "Try again"', async (detail) => {
    mockGrant.mockResolvedValue({ ok: false, reason: 'refused', detail })
    render(<FundMerchantModal {...PROPS} />)
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => screen.getByRole('button', { name: 'Sign budget' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign budget' }))
    await waitFor(() => expect(screen.getByText('The budget could not be set')).toBeDefined())
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    // The header's own icon-only Close button is aria-label "Close" and is
    // always present; the footer text button is a distinct visible "Close" —
    // that one must be absent here (Reload page is the SOLE footer action).
    expect(screen.queryByText('Close')).toBeNull()
  })

  it.each([
    'Merchant does not accept ERC-7710 payments on this chain; its payments use the open budget',
    "Merchant's payTo is one of this agent's own addresses; a merchant-locked budget cannot be issued to it",
    'Revoked agents cannot receive new budget delegations',
    'Delegation rail not enabled on chain 8453',
  ])('a permanent refusal ("%s") offers only "Close", never "Try again"', async (detail) => {
    mockGrant.mockResolvedValue({ ok: false, reason: 'refused', detail })
    render(<FundMerchantModal {...PROPS} />)
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => screen.getByRole('button', { name: 'Sign budget' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign budget' }))
    await waitFor(() => expect(screen.getByText('The budget could not be set')).toBeDefined())
    expect(screen.getByText('Close').closest('button')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it.each([
    ['A key rotation is in flight for this agent — finish or abandon the re-key before granting a new budget'],
    ['Agent cannot receive a budget while its account or re-key is unavailable'],
    ['some future backend refusal text'],
  ])('a transient/unknown refusal ("%s") keeps Close + "Try again"', async (detail) => {
    mockGrant.mockResolvedValue({ ok: false, reason: 'refused', detail })
    render(<FundMerchantModal {...PROPS} />)
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => screen.getByRole('button', { name: 'Sign budget' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign budget' }))
    await waitFor(() => expect(screen.getByText('The budget could not be set')).toBeDefined())
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined()
    expect(screen.getByText('Close').closest('button')).toBeDefined()
  })

  it('an unrecognised refusal detail falls back to the generic sentence, never raw backend prose (#3331 F9)', async () => {
    mockGrant.mockResolvedValue({ ok: false, reason: 'refused', detail: 'some future backend refusal text' })
    render(<FundMerchantModal {...PROPS} />)
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => screen.getByRole('button', { name: 'Sign budget' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign budget' }))
    await waitFor(() => expect(screen.getByText(/Haven could not set up this budget\./)).toBeDefined())
    expect(screen.queryByText('some future backend refusal text')).toBeNull()
  })

  it('a bare "failed" outcome uses the SAME heading and the same generic sentence + "Nothing changed." (#3331 F9)', async () => {
    mockGrant.mockResolvedValue({ ok: false, reason: 'failed' })
    render(<FundMerchantModal {...PROPS} />)
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => screen.getByRole('button', { name: 'Sign budget' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign budget' }))
    await waitFor(() => expect(screen.getByText('The budget could not be set')).toBeDefined())
    expect(screen.getByText(/Haven could not set up this budget\. Nothing changed\./)).toBeDefined()
  })

  it('a cancelled signature returns to review, not an error state', async () => {
    mockGrant.mockResolvedValue({ ok: false, reason: 'cancelled' })
    render(<FundMerchantModal {...PROPS} />)
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => screen.getByRole('button', { name: 'Sign budget' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign budget' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign budget' })).toBeDefined())
    expect(screen.queryByText('The budget could not be set')).toBeNull()
  })

  it('outcome language only — no delegation/caveat/recipient-pin/ERC-7710 jargon anywhere in the modal', () => {
    const { container } = render(<FundMerchantModal {...PROPS} />)
    expect(container.textContent).not.toMatch(/delegation|caveat|recipient pin|erc-?7710/i)
  })
})

/**
 * Contract test (#3331): the build body `grant()` sends for a merchant-locked
 * budget must satisfy the generated request shape for
 * `POST /agents/{id}/delegations/build` — `ApiOperations` is the same
 * generated-types entry point `useAccounting.ts` already uses for this
 * purpose. Checked at the type level (this file is covered by
 * `npm run typecheck`); the runtime assertions below pin the two fields the
 * merchant-locked path adds so the check is not vacuous.
 */
describe('contract: the merchant-locked build body matches the OpenAPI spec (#3331)', () => {
  type BuildAgentDelegationBody = ApiOperations['buildAgentDelegation']['requestBody']['content']['application/json']

  it('a merchant-locked build body satisfies the generated request schema, with the displayed payTo as recipient_address (#3331 F1)', () => {
    const body = {
      token_address: USDC_SEPOLIA,
      recipient_address: PAY_TO,
      budget_atomic: '5000000',
      period_seconds: 2_592_000,
      merchant_slug: merchant.slug,
    } satisfies BuildAgentDelegationBody
    expect(body.merchant_slug).toBe('ampersend-demo-api')
    expect(body.recipient_address).toBe(PAY_TO)
  })
})
