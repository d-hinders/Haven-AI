import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mockUseMerchant, mockUseAgents, mockUseMerchantBudgets, mockNotFound } = vi.hoisted(() => ({
  mockUseMerchant: vi.fn(),
  mockUseAgents: vi.fn(),
  mockUseMerchantBudgets: vi.fn(),
  mockNotFound: vi.fn(),
}))

vi.mock('@/hooks/useCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useCatalog')>()
  return { ...actual, useMerchant: () => mockUseMerchant() }
})

vi.mock('@/hooks/useAgents', () => ({
  useAgents: () => mockUseAgents(),
}))

vi.mock('@/hooks/useMerchantBudgets', () => ({
  useMerchantBudgets: () => mockUseMerchantBudgets(),
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ slug: 'ampersend-demo-api' }),
  notFound: () => mockNotFound(),
}))

import MerchantPage from '../page'
import type { CatalogEntry, Merchant, MerchantFundingTarget } from '@/hooks/useCatalog'
import type { Agent } from '@/hooks/useAgents'

// #3331 review finding F6: the action needs at least one ELIGIBLE agent, not
// just a qualifying chain — this fixture is the one Agent shape that
// `eligibleFundingAgents` accepts for `verifiedErc7710Funding` below (chain
// 84532, active, not archived).
const eligibleAgent: Agent = {
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
  // #3426: the fixture is type-checked against the wire schema; the opt-in
  // defaults OFF on every agent read.
  tax_declaration_enabled: false,
} as Agent

const merchant: Merchant = {
  id: 'm-1',
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

function offer(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'offer-1',
    name: 'Joke',
    description: 'Returns a joke.',
    category: 'api',
    resource_url: 'https://services.sandbox.ampersend.ai/api/joke',
    merchant: {
      id: merchant.id,
      slug: merchant.slug,
      name: merchant.name,
      listing_status: 'live',
      is_test_merchant: false,
    },
    rail: 'x402',
    protocol: 'http',
    tool_name: null,
    tool_arguments: null,
    tool_arguments_schema: null,
    http_method: null,
    body_type: null,
    body_example: null,
    price_display: '$0.001 USDC',
    price_atomic: '1000',
    asset: 'USDC',
    network: 'eip155:84532',
    asset_transfer_methods: null,
    status: 'active',
    verified_at: new Date().toISOString(),
    source: 'operator',
    domain_verified: false,
    verified_payable: true,
    ...overrides,
  }
}

describe('MerchantPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseAgents.mockReturnValue({ agents: [] })
    mockUseMerchantBudgets.mockReturnValue({ budgets: [], loading: false, error: null, forbidden: false, refetch: vi.fn() })
  })

  it('renders a loading state', () => {
    mockUseMerchant.mockReturnValue({
      merchant: null,
      offers: [],
      loading: true,
      error: null,
      notFound: false,
      refetch: vi.fn(),
    })
    render(<MerchantPage />)
    expect(screen.queryByText('Ampersend Demo API')).toBeNull()
    // The loading shell is marked busy (skeletons are aria-hidden).
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true')
  })

  it('renders an error state', () => {
    mockUseMerchant.mockReturnValue({
      merchant: null,
      offers: [],
      loading: false,
      error: 'boom',
      notFound: false,
      refetch: vi.fn(),
    })
    render(<MerchantPage />)
    expect(screen.getByText('Could not load this merchant')).toBeDefined()
    expect(screen.getByText('boom')).toBeDefined()
  })

  it('designs the merchant-less 200 (no notFound, no error) instead of rendering nothing', () => {
    const refetch = vi.fn()
    mockUseMerchant.mockReturnValue({ merchant: null, offers: [], loading: false, error: null, notFound: false, refetch })
    const { container } = render(<MerchantPage />)
    expect(container.textContent).toContain('Could not load this merchant')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(refetch).toHaveBeenCalledTimes(1)
    expect(mockNotFound).not.toHaveBeenCalled()
  })

  it('offers the way back to the marketplace from EVERY branch — success, loading, error, merchant-less', () => {
    const states = [
      { merchant, offers: [offer()], loading: false, error: null, notFound: false, refetch: vi.fn() },
      { merchant: null, offers: [], loading: true, error: null, notFound: false, refetch: vi.fn() },
      { merchant: null, offers: [], loading: false, error: 'boom', notFound: false, refetch: vi.fn() },
      { merchant: null, offers: [], loading: false, error: null, notFound: false, refetch: vi.fn() },
    ]
    for (const state of states) {
      mockUseMerchant.mockReturnValue(state)
      const { unmount } = render(<MerchantPage />)
      const link = screen.getByRole('link', { name: 'Back to Marketplace' })
      expect(link.getAttribute('href')).toBe('/marketplace')
      // The Button primitive, not a hand-rolled 16 px link: it carries the
      // 44 px hit area and the focus ring on a phone.
      expect(link.className).toContain('focus-visible:')
      unmount()
    }
  })

  it('calls notFound() for an unknown slug', () => {
    mockUseMerchant.mockReturnValue({
      merchant: null,
      offers: [],
      loading: false,
      error: null,
      notFound: true,
      refetch: vi.fn(),
    })
    render(<MerchantPage />)
    expect(mockNotFound).toHaveBeenCalled()
  })

  it('renders the pay-with-Haven block and offers table for a live merchant with offers', () => {
    mockUseMerchant.mockReturnValue({
      merchant,
      offers: [offer()],
      loading: false,
      error: null,
      notFound: false,
      refetch: vi.fn(),
    })
    render(<MerchantPage />)
    expect(screen.getByText('Pay this with Haven')).toBeDefined()
    expect(screen.getByText('Offers')).toBeDefined()
    expect(screen.getByLabelText(/Copy agent instruction/)).toBeDefined()
  })

  it('shows the unpinned-budget line only when erc7710 is absent from asset_transfer_methods', () => {
    mockUseMerchant.mockReturnValue({
      merchant,
      offers: [offer({ asset_transfer_methods: null }), offer({ id: 'offer-2', asset_transfer_methods: 'eip3009,erc7710' })],
      loading: false,
      error: null,
      notFound: false,
      refetch: vi.fn(),
    })
    render(<MerchantPage />)
    // The merchant-level note renders ONCE (not per offer), and in the mixed
    // case the offers that need the unpinned budget are the tagged ones.
    expect(screen.getAllByText(/This merchant settles by EIP-3009 — the paying agent needs an unpinned budget\./)).toHaveLength(1)
    expect(screen.getAllByText('unpinned budget')).toHaveLength(1)
    expect(screen.getByTestId('pay-block-offer-1').textContent).toContain('unpinned budget')
    expect(screen.getByTestId('pay-block-offer-2').textContent).not.toContain('unpinned budget')
  })

  it('renders the coming-soon branch with no instruction block and no offers table', () => {
    mockUseMerchant.mockReturnValue({
      merchant: { ...merchant, listing_status: 'coming_soon', offer_count: 0 },
      offers: [],
      loading: false,
      error: null,
      notFound: false,
      refetch: vi.fn(),
    })
    render(<MerchantPage />)
    expect(screen.getByText('Coming soon — not payable yet')).toBeDefined()
    expect(screen.queryByText('Pay this with Haven')).toBeNull()
    expect(screen.queryByText('Offers')).toBeNull()
    expect(screen.queryByLabelText(/Copy agent instruction/)).toBeNull()
  })

  it('renders an empty-offers state for a live merchant with none', () => {
    mockUseMerchant.mockReturnValue({
      merchant,
      offers: [],
      loading: false,
      error: null,
      notFound: false,
      refetch: vi.fn(),
    })
    render(<MerchantPage />)
    expect(screen.getByText('No offers listed yet')).toBeDefined()
  })

  // ── "Fund this merchant" (#3331) ──────────────────────────────────────────
  const verifiedErc7710Funding: MerchantFundingTarget[] = [
    { network: 'eip155:84532', chain_id: 84532, pay_to: '0x' + 'f0'.repeat(20), pay_to_status: 'verified', erc7710: true },
  ]
  const verifiedNotErc7710Funding: MerchantFundingTarget[] = [
    { network: 'eip155:84532', chain_id: 84532, pay_to: '0x' + 'f0'.repeat(20), pay_to_status: 'verified', erc7710: false },
  ]
  const unstatedFunding: MerchantFundingTarget[] = [
    { network: 'eip155:84532', chain_id: 84532, pay_to: null, pay_to_status: 'unstated', erc7710: false },
  ]

  it('renders the action when a listed chain has a verified, ERC-7710 payTo AND the owner has an eligible agent', () => {
    mockUseAgents.mockReturnValue({ agents: [eligibleAgent] })
    mockUseMerchant.mockReturnValue({
      merchant,
      offers: [offer()],
      funding: verifiedErc7710Funding,
      loading: false,
      error: null,
      notFound: false,
      refetch: vi.fn(),
    })
    render(<MerchantPage />)
    expect(screen.getByRole('button', { name: 'Fund this merchant' })).toBeDefined()
  })

  // #3331 review finding F6: the chain qualifies but NONE of the owner's own
  // agents do — the action must not show a Review that can only ever land on
  // "no eligible agent", and the open-budget note (a DIFFERENT case: a
  // verified payTo that is not ERC-7710) must not show here either.
  //
  // Round 2 review finding R2-5 (design 3): this used to leave the whole slot
  // BLANK — now it says why, and how to fix it, with a link to /agents.
  it('shows a plain "connect an agent" line (not the open-budget note) when a chain qualifies but the owner has no eligible agent', () => {
    mockUseAgents.mockReturnValue({ agents: [], loading: false })
    mockUseMerchant.mockReturnValue({
      merchant,
      offers: [offer()],
      funding: verifiedErc7710Funding,
      loading: false,
      error: null,
      notFound: false,
      refetch: vi.fn(),
    })
    render(<MerchantPage />)
    expect(screen.queryByRole('button', { name: 'Fund this merchant' })).toBeNull()
    expect(screen.queryByText(/use an agent's open budget/)).toBeNull()
    expect(
      screen.getByText(/Connect an agent on Base Sepolia to give it a budget for Ampersend Demo API\./),
    ).toBeDefined()
    // Design review round 3, finding C: the link text must not repeat
    // "Connect an agent" — the sentence right before it already says that.
    expect(screen.getByRole('link', { name: 'Go to Agents' }).getAttribute('href')).toBe('/agents')
  })

  // Design review round 3, finding C (code F5): a failed agents read reads
  // `agents: []` from `useAgents`, identical to "no eligible agent" — the
  // page must not claim "Connect an agent" over a read that simply failed.
  it('shows a neutral line, not "Connect an agent", when useAgents itself errored', () => {
    mockUseAgents.mockReturnValue({ agents: [], loading: false, error: 'boom' })
    mockUseMerchant.mockReturnValue({
      merchant,
      offers: [offer()],
      funding: verifiedErc7710Funding,
      loading: false,
      error: null,
      notFound: false,
      refetch: vi.fn(),
    })
    render(<MerchantPage />)
    expect(screen.queryByRole('button', { name: 'Fund this merchant' })).toBeNull()
    expect(screen.queryByText(/Connect an agent/)).toBeNull()
    expect(screen.getByText(/Haven could not load your agents just now, so funding is unavailable\. Reload the page to try again\./)).toBeDefined()
  })

  // Design review round 3, finding C: several pinnable chains must each be
  // named — the sentence used to always read the first chain only.
  it('names every pinnable chain when the merchant qualifies on more than one', () => {
    mockUseAgents.mockReturnValue({ agents: [], loading: false })
    mockUseMerchant.mockReturnValue({
      merchant,
      offers: [offer()],
      funding: [
        ...verifiedErc7710Funding,
        { network: 'eip155:100', chain_id: 100, pay_to: '0x' + '22'.repeat(20), pay_to_status: 'verified', erc7710: true },
      ],
      loading: false,
      error: null,
      notFound: false,
      refetch: vi.fn(),
    })
    render(<MerchantPage />)
    expect(screen.getByText(/Connect an agent on Base Sepolia or Gnosis Chain to give it a budget/)).toBeDefined()
  })

  it('shows neither the action nor the connect-agent note while agents are still loading — no flash (R2-5)', () => {
    mockUseAgents.mockReturnValue({ agents: [], loading: true })
    mockUseMerchant.mockReturnValue({
      merchant,
      offers: [offer()],
      funding: verifiedErc7710Funding,
      loading: false,
      error: null,
      notFound: false,
      refetch: vi.fn(),
    })
    render(<MerchantPage />)
    expect(screen.queryByRole('button', { name: 'Fund this merchant' })).toBeNull()
    expect(screen.queryByText(/Connect an agent on/)).toBeNull()
  })

  it('withholds the action, with open-budget copy, when the only verified payTo is not ERC-7710', () => {
    mockUseMerchant.mockReturnValue({
      merchant,
      offers: [offer()],
      funding: verifiedNotErc7710Funding,
      loading: false,
      error: null,
      notFound: false,
      refetch: vi.fn(),
    })
    render(<MerchantPage />)
    expect(screen.queryByRole('button', { name: 'Fund this merchant' })).toBeNull()
    expect(screen.getByText(/use an agent's open budget/)).toBeDefined()
  })

  it('renders neither the action nor the open-budget copy with no verified payTo at all', () => {
    mockUseMerchant.mockReturnValue({
      merchant,
      offers: [offer()],
      funding: unstatedFunding,
      loading: false,
      error: null,
      notFound: false,
      refetch: vi.fn(),
    })
    render(<MerchantPage />)
    expect(screen.queryByRole('button', { name: 'Fund this merchant' })).toBeNull()
    expect(screen.queryByText(/use an agent's open budget/)).toBeNull()
  })

  it('never renders the action for a coming_soon merchant, even with funding data', () => {
    mockUseMerchant.mockReturnValue({
      merchant: { ...merchant, listing_status: 'coming_soon', offer_count: 0 },
      offers: [],
      funding: verifiedErc7710Funding,
      loading: false,
      error: null,
      notFound: false,
      refetch: vi.fn(),
    })
    render(<MerchantPage />)
    expect(screen.queryByRole('button', { name: 'Fund this merchant' })).toBeNull()
  })

  it('renders merchant-locked budgets, with pin_status and #1319 provenance, when GET /merchants/:slug/budgets returns rows', () => {
    mockUseMerchant.mockReturnValue({
      merchant,
      offers: [offer()],
      funding: verifiedErc7710Funding,
      loading: false,
      error: null,
      notFound: false,
      refetch: vi.fn(),
    })
    mockUseMerchantBudgets.mockReturnValue({
      budgets: [
        {
          agent_id: 'agent-1',
          agent_name: 'Research Agent',
          chain_id: 84532,
          token_address: '0x' + 'aa'.repeat(20),
          recipient_address: '0x' + 'f0'.repeat(20),
          delegation_hash: '0x' + 'bb'.repeat(32),
          budget_atomic: '10000000',
          period_seconds: 2_592_000,
          expires_at: '4102444800',
          remaining_atomic: '10000000',
          remaining_is_from_chain: false,
          pin_status: 'stale',
        },
      ],
      loading: false,
      error: null,
      forbidden: false,
      refetch: vi.fn(),
    })
    render(<MerchantPage />)
    expect(screen.getByText('Research Agent')).toBeDefined()
    expect(screen.getByText('Old address')).toBeDefined()
    expect(screen.getByText(/could not confirm the live figure/)).toBeDefined()
  })

  it('renders no merchant-budgets section when there are none', () => {
    mockUseMerchant.mockReturnValue({
      merchant,
      offers: [offer()],
      funding: verifiedErc7710Funding,
      loading: false,
      error: null,
      notFound: false,
      refetch: vi.fn(),
    })
    render(<MerchantPage />)
    expect(screen.queryByTestId('merchant-budgets-list')).toBeNull()
  })
})
