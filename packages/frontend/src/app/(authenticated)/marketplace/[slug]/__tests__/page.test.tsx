import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mockUseMerchant, mockUseAgents, mockNotFound } = vi.hoisted(() => ({
  mockUseMerchant: vi.fn(),
  mockUseAgents: vi.fn(),
  mockNotFound: vi.fn(),
}))

vi.mock('@/hooks/useCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useCatalog')>()
  return { ...actual, useMerchant: () => mockUseMerchant() }
})

vi.mock('@/hooks/useAgents', () => ({
  useAgents: () => mockUseAgents(),
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ slug: 'ampersend-demo-api' }),
  notFound: () => mockNotFound(),
}))

import MerchantPage from '../page'
import type { CatalogEntry, Merchant } from '@/hooks/useCatalog'

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
    mockUseAgents.mockReturnValue({ agents: [] })
    vi.clearAllMocks()
    mockUseAgents.mockReturnValue({ agents: [] })
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

  it('offers the way back to the marketplace from the merchant page', () => {
    mockUseMerchant.mockReturnValue({ merchant, offers: [offer()], loading: false, error: null, notFound: false, refetch: vi.fn() })
    render(<MerchantPage />)
    expect(screen.getByRole('link', { name: '← Marketplace' }).getAttribute('href')).toBe('/marketplace')
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
})
