import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiOperations } from '@haven_ai/core'
import type { Agent } from '@/hooks/useAgents'
import type { CatalogEntry, Merchant, MerchantFundingTarget } from '@/hooks/useCatalog'
import type { DelegationBudget } from '@/hooks/useDelegationBudget'

const { mockGrant, mockReady, mockBudgets } = vi.hoisted(() => ({
  mockGrant: vi.fn(),
  mockReady: vi.fn(() => true),
  mockBudgets: vi.fn((): unknown[] | null => []),
}))

vi.mock('@/hooks/useDelegationBudget', () => ({
  useDelegationBudget: () => ({
    budgets: mockBudgets(),
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

  it('shows a no-eligible-agent message when none of the agents qualify', () => {
    render(<FundMerchantModal {...PROPS} agents={[agent({ account_chain_id: 8453 })]} />)
    expect(screen.getByText(/No connected agent can be pinned/)).toBeDefined()
    expect(screen.queryByLabelText('Agent')).toBeNull()
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

  it('review step: no warning with no conflicting active budget', async () => {
    mockBudgets.mockReturnValue([])
    render(<FundMerchantModal {...PROPS} />)
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign budget' })).toBeDefined())
    expect(screen.queryByText(/replaces/)).toBeNull()
  })

  it('signs via grant() with merchantSlug, and reports success', async () => {
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
        recipientAddress: null,
        budgetAtomic: '5000000',
        periodSeconds: 2_592_000,
        merchantSlug: 'ampersend-demo-api',
      }),
    )
    expect(onGranted).toHaveBeenCalled()
  })

  // ── error mapping of the 409s (#3331) ──────────────────────────────────
  const CASES: Array<[string, RegExp]> = [
    [
      'Merchant has no verified payTo on this chain; a merchant-locked budget cannot be issued yet',
      /does not have a confirmed payment address/,
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
  ]

  it.each(CASES)('maps the %s refusal to its own copy', async (detail, expected) => {
    mockGrant.mockResolvedValue({ ok: false, reason: 'refused', detail })
    render(<FundMerchantModal {...PROPS} />)
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => screen.getByRole('button', { name: 'Sign budget' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign budget' }))
    await waitFor(() => expect(screen.getByText('The budget could not be set')).toBeDefined())
    expect(screen.getByText(expected)).toBeDefined()
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

  it('a merchant-locked build body satisfies the generated request schema', () => {
    const body = {
      token_address: USDC_SEPOLIA,
      recipient_address: null,
      budget_atomic: '5000000',
      period_seconds: 2_592_000,
      merchant_slug: merchant.slug,
    } satisfies BuildAgentDelegationBody
    expect(body.merchant_slug).toBe('ampersend-demo-api')
    expect(body.recipient_address).toBeNull()
  })
})
