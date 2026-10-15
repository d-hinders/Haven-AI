import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mockUseMerchant, mockUseAgents, mockUseMerchantBudgets, mockUseBudgetRemaining, mockUseAuth, mockNotFound } = vi.hoisted(() => ({
  mockUseMerchant: vi.fn(),
  mockUseAgents: vi.fn(),
  mockUseMerchantBudgets: vi.fn(),
  mockUseBudgetRemaining: vi.fn(),
  mockUseAuth: vi.fn(),
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

vi.mock('@/hooks/useBudgetRemaining', () => ({
  useBudgetRemaining: () => mockUseBudgetRemaining(),
}))

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ slug: 'ampersend-demo-api' }),
  notFound: () => mockNotFound(),
}))

import MerchantPage from '../page'
import type { CatalogEntry, Merchant, MerchantFundingTarget } from '@/hooks/useCatalog'
import type { Agent } from '@/hooks/useAgents'
import type { DashboardBudgetRemainingEntry } from '@/hooks/useBudgetRemaining'
// #4005: the fixtures below are built from apiMock()'s typed route table
// (frontend playbook §4) — a spread of the e2e fixture's own wire-shaped
// defaults, so a dropped required field is a tsc error, not a screen
// rendering undefined.
import { API_MOCK_DEFAULTS } from '../../../../../../e2e/fixtures/api-mock'

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
  lowest_price_atomic: '1000',
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
    price_display: '0.001 USDC',
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
    // #4005: the panel reads the cached budget-remaining wire — idle by
    // default, so the tests that need amounts seed it explicitly below.
    mockUseBudgetRemaining.mockReturnValue({ data: null, loading: false, error: null, refetch: vi.fn() })
    // #3981: the offers on the user's own network come first — the default
    // account here is on Base Sepolia.
    mockUseAuth.mockReturnValue({ user: { accounts: [{ id: 'acc-1', chain_id: 84532, is_default: true }] } })
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

  it('renders ONE offers section for a live merchant with offers — no "Pay this with Haven", no "List your payable service"', () => {
    mockUseMerchant.mockReturnValue({
      merchant,
      offers: [offer()],
      loading: false,
      error: null,
      notFound: false,
      refetch: vi.fn(),
    })
    render(<MerchantPage />)
    // #3981: the pay block folded into the offers section — one heading, not two.
    expect(screen.getByRole('heading', { name: 'Offers' })).toBeDefined()
    expect(screen.queryByText('Pay this with Haven')).toBeNull()
    // One copy button per shape: the desktop row and the phone card.
    expect(screen.getAllByRole('button', { name: 'Copy prompt for Joke' })).toHaveLength(2)
    expect(screen.queryByText('List your payable service')).toBeNull()
    // The header is still the page's only h1.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })

  it('#4005: the offer-level note is gone — the panel carries the requirement, the rows keep only the tag', () => {
    mockUseAgents.mockReturnValue({ agents: [eligibleAgent] })
    // Built from apiMock()'s /dashboard/budget-remaining default: the fixture
    // row is testAgent's on Base; re-keyed here to the page's agent and chain.
    const budgetRow = {
      ...API_MOCK_DEFAULTS['/dashboard/budget-remaining'].budgets[0]!,
      agent_id: 'agent-1',
      chain_id: 84532,
      remaining_atomic: '20000000',
    } satisfies DashboardBudgetRemainingEntry
    mockUseBudgetRemaining.mockReturnValue({ data: { budgets: [budgetRow] }, loading: false, error: null, refetch: vi.fn() })
    mockUseMerchant.mockReturnValue({
      merchant,
      offers: [offer({ asset_transfer_methods: null }), offer({ id: 'offer-2', asset_transfer_methods: 'eip3009,erc7710' })],
      loading: false,
      error: null,
      notFound: false,
      refetch: vi.fn(),
    })
    render(<MerchantPage />)
    // The separate paragraph above the table is gone.
    expect(screen.queryByTestId('any-recipient-budget-note')).toBeNull()
    // In the mixed case only the offers that need an any-recipient budget are tagged.
    expect(screen.getByTestId('offer-row-offer-1').textContent).toContain('any-recipient budget')
    expect(screen.getByTestId('offer-row-offer-2').textContent).not.toContain('any-recipient budget')
    // The requirement lives in the panel's step 2, in plain words.
    expect(screen.getByTestId('how-to-buy-step-2').textContent).toContain(
      'The offers marked "any-recipient budget" need a budget that can pay anyone.',
    )
    // No protocol jargon reaches the page.
    expect(document.body.textContent).not.toContain('EIP-3009')
    expect(document.body.textContent).not.toContain('unpinned')
  })

  it('groups a merchant\'s offers by the user\'s default network, others behind a disclosure; flat when the default network serves none', () => {
    mockUseMerchant.mockReturnValue({
      merchant,
      offers: [offer({ id: 'sepolia' }), offer({ id: 'base', network: 'eip155:8453' })],
      loading: false,
      error: null,
      notFound: false,
      refetch: vi.fn(),
    })
    const { unmount } = render(<MerchantPage />)
    expect(screen.getAllByText('1 more on Base — none of your agents can pay on that network')).toHaveLength(2)
    expect(screen.getAllByTestId('offer-row-sepolia')).toHaveLength(1)
    expect(screen.getAllByTestId('offer-row-base')).toHaveLength(1)
    unmount()
    // No default account on any network the offers use → all flat.
    mockUseAuth.mockReturnValue({ user: null })
    render(<MerchantPage />)
    expect(screen.queryByText(/more on/)).toBeNull()
  })

  it('renders the coming-soon branch with no offers section and no copy buttons', () => {
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
    expect(screen.queryByRole('heading', { name: 'Offers' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Copy prompt/ })).toBeNull()
    expect(screen.queryByText('List your payable service')).toBeNull()
  })

  it('renders an empty-offers state for a live merchant with none, and no "List your payable service" either', () => {
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
    expect(screen.queryByText('List your payable service')).toBeNull()
  })

  // ── The "How to buy" panel (#4005) ─────────────────────────────────────────
  const verifiedErc7710Funding: MerchantFundingTarget[] = [
    { network: 'eip155:84532', chain_id: 84532, pay_to: '0x' + 'f0'.repeat(20), pay_to_status: 'verified', erc7710: true },
  ]
  const verifiedNotErc7710Funding: MerchantFundingTarget[] = [
    { network: 'eip155:84532', chain_id: 84532, pay_to: '0x' + 'f0'.repeat(20), pay_to_status: 'verified', erc7710: false },
  ]
  const unstatedFunding: MerchantFundingTarget[] = [
    { network: 'eip155:84532', chain_id: 84532, pay_to: null, pay_to_status: 'unstated', erc7710: false },
  ]

  // Built from apiMock()'s /dashboard/budget-remaining default: the fixture
  // row is testAgent's on Base; re-keyed to the page's agent, chain and a
  // remaining that covers the 0.001 USDC offer.
  const sepoliaBudgetRow = {
    ...API_MOCK_DEFAULTS['/dashboard/budget-remaining'].budgets[0]!,
    agent_id: 'agent-1',
    chain_id: 84532,
    remaining_atomic: '20000000',
  } satisfies DashboardBudgetRemainingEntry

  function seedPayingState(funding: MerchantFundingTarget[] = verifiedErc7710Funding, offers: CatalogEntry[] = [offer()]) {
    mockUseAgents.mockReturnValue({ agents: [eligibleAgent] })
    mockUseBudgetRemaining.mockReturnValue({ data: { budgets: [sepoliaBudgetRow] }, loading: false, error: null, refetch: vi.fn() })
    mockUseMerchant.mockReturnValue({ merchant, offers, funding, loading: false, error: null, notFound: false, refetch: vi.fn() })
  }

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
    // TWO controls carry the action now — the header slot and the panel's
    // step-2 fix — both open the same modal.
    expect(screen.getAllByRole('button', { name: 'Set a budget for this merchant' })).toHaveLength(2)
  })

  it('renders the panel between the header and the offers for a live merchant with offers', () => {
    seedPayingState()
    render(<MerchantPage />)
    const panel = screen.getByTestId('how-to-buy-panel')
    const offersHeading = screen.getByRole('heading', { name: 'Offers' })
    // The panel precedes the offers section in the DOM.
    expect(Boolean(panel.compareDocumentPosition(offersHeading) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  })

  // The old connect-agent note's case, in the panel's terms: no agent to
  // point at, so step 1 is open with the /agents link and steps 2–3 claim
  // nothing about budgets the user does not have yet.
  it('no active agents: step 1 is open with a link to /agents; steps 2 and 3 claim nothing', () => {
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
    expect(screen.getByTestId('how-to-buy-step-1').textContent).toContain('Connect an agent to buy from Ampersend Demo API.')
    expect(screen.getByRole('link', { name: 'Go to Agents' }).getAttribute('href')).toBe('/agents')
    expect(screen.getByTestId('how-to-buy-step-2').textContent).toContain('Once an agent is connected')
    expect(screen.getByTestId('how-to-buy-step-3').textContent).toContain("paste it into your agent's chat")
    expect(screen.queryByRole('button', { name: 'Set a budget for this merchant' })).toBeNull()
  })

  // Design review round 3, finding C (code F5), rewritten for #4005: a failed
  // agents read reads `agents: []`, identical to "no eligible agent" — the
  // panel must not claim "Connect an agent" over a read that simply failed.
  it('a failed agents read never renders "Connect an agent" — the panel says the load failed', () => {
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
    expect(screen.getByTestId('how-to-buy-step-1').textContent).toContain("Haven couldn't load your agents.")
    expect(screen.queryByText(/Connect an agent to buy from/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Set a budget for this merchant' })).toBeNull()
  })

  // Design review round 3, finding C (every chain named), rewritten: with an
  // agent on the wrong chain, step 2 names the agent's chain AND every chain
  // the offers are on — the sentence that used to name the pinnable chains.
  it('wrong network: step 2 names the agent chain and every offer chain, with no fix button', () => {
    mockUseAgents.mockReturnValue({ agents: [{ ...eligibleAgent, account_chain_id: 8453 }] })
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
    expect(screen.getByTestId('how-to-buy-step-2').textContent).toContain(
      "Research Agent's Haven wallet is on Base — this merchant's offers are on Base Sepolia. Haven can't add a second account from here.",
    )
    expect(screen.getByTestId('how-to-buy-step-2').textContent).not.toContain('Set a budget')
  })

  it('while agents load the panel shows skeletons and claims nothing — no flash (R2-5)', () => {
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
    expect(document.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0)
    expect(screen.queryByText(/Connect an agent to buy from/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Set a budget for this merchant' })).toBeNull()
  })

  // An agent that can pay: all three steps read done or ready, and step 2
  // names the agent and its REMAINING amount — the #4004 figures, not a cap.
  it('an agent that can pay: step 1 done, step 2 names the agent and its remaining amount, step 3 names the paste target', () => {
    seedPayingState()
    render(<MerchantPage />)
    expect(screen.getByTestId('how-to-buy-step-1').textContent).toContain('Research Agent is connected on Base Sepolia.')
    expect(screen.getByTestId('how-to-buy-step-2').textContent).toContain(
      'Research Agent has 20 USDC left of 250 USDC, and can pay anyone — so it can pay Ampersend Demo API.',
    )
    expect(screen.getByTestId('how-to-buy-step-3').textContent).toContain("paste it into Research Agent's chat")
    expect(screen.getByRole('link', { name: 'Transactions' }).getAttribute('href')).toBe('/transactions')
  })

  it('a failed budget read: step 2 says it could not check budgets, with a retry', () => {
    mockUseAgents.mockReturnValue({ agents: [eligibleAgent] })
    mockUseBudgetRemaining.mockReturnValue({ data: null, loading: false, error: 'boom', refetch: vi.fn() })
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
    expect(screen.getByTestId('how-to-buy-step-2').textContent).toContain("Haven couldn't check budgets — try again.")
  })

  // The old open-budget note's case: offers lack erc7710, so the requirement
  // shows in the panel's step 2 — even when no budget can be PINNED here.
  it('withholds the fund action and carries the any-recipient requirement in step 2 when the only verified payTo is not ERC-7710', () => {
    seedPayingState(verifiedNotErc7710Funding)
    render(<MerchantPage />)
    const step2 = screen.getByTestId('how-to-buy-step-2')
    expect(step2.textContent).toContain('and can pay anyone — so it can pay Ampersend Demo API.')
    expect(step2.textContent).toContain("A budget limited to one recipient can't pay Ampersend Demo API — keep the budget that can pay anyone open.")
    expect(screen.queryByRole('button', { name: 'Set a budget for this merchant' })).toBeNull()
  })

  it('renders no any-recipient requirement anywhere when the offers advertise erc7710, even with no verified payTo at all', () => {
    seedPayingState(unstatedFunding, [offer({ asset_transfer_methods: 'eip3009,erc7710' })])
    render(<MerchantPage />)
    expect(screen.getByTestId('how-to-buy-step-2').textContent).toContain('and can pay anyone')
    expect(document.body.textContent).not.toContain('any-recipient budget')
  })

  // #4005: after a copy, the confirmation names the ONE agent that can pay.
  it("the copy confirmation reads 'Copied — paste it to <agent>' when exactly one agent can pay", async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    })
    seedPayingState()
    render(<MerchantPage />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy prompt for Joke' })[0]!)
    await vi.waitFor(() => {
      expect(screen.getAllByRole('button', { name: /Prompt for Joke copied/ })[0]!.textContent).toBe(
        'Copied — paste it to Research Agent',
      )
    })
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
    expect(screen.queryByRole('button', { name: 'Set a budget for this merchant' })).toBeNull()
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
