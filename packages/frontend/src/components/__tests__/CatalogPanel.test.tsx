import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockUseCatalog, mockUseAgents, mockUseAuth } = vi.hoisted(() => ({
  mockUseCatalog: vi.fn(),
  mockUseAgents: vi.fn(),
  mockUseAuth: vi.fn(),
}))

vi.mock('@/hooks/useCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useCatalog')>()
  return { ...actual, useCatalog: () => mockUseCatalog() }
})

vi.mock('@/hooks/useAgents', () => ({
  useAgents: () => mockUseAgents(),
}))

// useChainScope (the real hook) reads the active chain from AuthContext.
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

import CatalogPanel, { agentInstruction, withinBudget, networkToChainId } from '../CatalogPanel'
import type { CatalogEntry } from '@/hooks/useCatalog'

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'cat-1',
    name: 'Text generation',
    description: 'Generate text content.',
    category: 'media',
    resource_url: 'https://mcp.merchant.example/mcp',
    rail: 'x402',
    protocol: 'mcp',
    tool_name: 'create_text',
    price_display: '$0.01 USDC',
    price_atomic: '10000',
    asset: 'USDC',
    network: 'eip155:8453',
    status: 'active',
    verified_at: new Date().toISOString(),
    ...overrides,
  }
}

const activeAgent = {
  status: 'active',
  allowances: [{ token_symbol: 'USDC', allowance_amount: '5000000' }],
}

describe('agentInstruction', () => {
  it('uses the pay-via-tool phrasing for MCP merchants', () => {
    expect(agentInstruction(entry())).toBe(
      'Pay https://mcp.merchant.example/mcp via create_text for <what you want>',
    )
  })

  it('uses plain pay phrasing for HTTP x402 merchants', () => {
    expect(agentInstruction(entry({ protocol: 'http', tool_name: null }))).toBe(
      'Pay https://mcp.merchant.example/mcp and return the result',
    )
  })

  it('uses MPP phrasing for MPP merchants', () => {
    expect(agentInstruction(entry({ rail: 'mpp', protocol: 'http', tool_name: null }))).toContain(
      'machine-payment resource',
    )
  })
})

describe('withinBudget', () => {
  it('is true when an active agent allowance covers the price', () => {
    expect(withinBudget(entry(), [activeAgent])).toBe(true)
  })

  it('is false when every allowance is below the price', () => {
    expect(
      withinBudget(entry({ price_atomic: '99000000' }), [activeAgent]),
    ).toBe(false)
  })

  it('ignores paused agents and unknown assets', () => {
    expect(withinBudget(entry(), [{ ...activeAgent, status: 'paused' }])).toBe(null)
    expect(withinBudget(entry({ asset: 'EURe' }), [activeAgent])).toBe(null)
    expect(withinBudget(entry({ price_atomic: null }), [activeAgent])).toBe(null)
  })
})

describe('networkToChainId', () => {
  it('resolves CAIP-2 and short-name network forms, undefined otherwise', () => {
    expect(networkToChainId('eip155:8453')).toBe(8453)
    expect(networkToChainId('eip155:84532')).toBe(84532)
    expect(networkToChainId('base')).toBe(8453)
    expect(networkToChainId('base-sepolia')).toBe(84532)
    expect(networkToChainId('gnosis')).toBe(100)
    expect(networkToChainId(null)).toBeUndefined()
    expect(networkToChainId('solana')).toBeUndefined()
  })
})

describe('CatalogPanel', () => {
  beforeEach(() => {
    mockUseAgents.mockReturnValue({ agents: [activeAgent] })
    // Active chain = Base mainnet by default (the existing entries are on Base).
    mockUseAuth.mockReturnValue({ activeSafe: { id: 's1', chain_id: 8453 } })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders entries with price, rail badge, and copy affordance', () => {
    mockUseCatalog.mockReturnValue({ entries: [entry()], loading: false, error: null })
    render(<CatalogPanel />)

    expect(screen.getByText('Text generation')).toBeDefined()
    expect(screen.getByText('$0.01 USDC')).toBeDefined()
    expect(screen.getByText('x402')).toBeDefined()
    expect(screen.getByLabelText('Copy agent instruction for Text generation')).toBeDefined()
    expect(screen.getByText('Within your agent budget')).toBeDefined()
  })

  it('filters by category', () => {
    mockUseCatalog.mockReturnValue({
      entries: [
        entry({ id: 'a', name: 'Media thing', category: 'media' }),
        entry({ id: 'b', name: 'Data thing', category: 'data' }),
      ],
      loading: false,
      error: null,
    })
    render(<CatalogPanel />)

    expect(screen.getByText('Media thing')).toBeDefined()
    expect(screen.getByText('Data thing')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'data' }))
    expect(screen.queryByText('Media thing')).toBeNull()
    expect(screen.getByText('Data thing')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getByText('Media thing')).toBeDefined()
  })

  it('keeps degraded entries usable with a calm availability note', () => {
    mockUseCatalog.mockReturnValue({
      entries: [entry({ status: 'degraded' })],
      loading: false,
      error: null,
    })
    render(<CatalogPanel />)

    expect(screen.getByText('Text generation')).toBeDefined()
    // Calm chip + one-liner instead of a scary dimmed card…
    expect(screen.getByText('Limited availability')).toBeDefined()
    expect(screen.getByText(/Recently unreachable/)).toBeDefined()
    // …and the offer stays fully usable (price + copy instruction).
    expect(screen.getByLabelText(/Copy agent instruction/)).toBeDefined()
  })

  it('shows the over-budget warning when no allowance covers the price', () => {
    mockUseCatalog.mockReturnValue({
      entries: [entry({ price_atomic: '99000000', price_display: '$99.00 USDC' })],
      loading: false,
      error: null,
    })
    render(<CatalogPanel />)

    expect(screen.getByText(/Exceeds every agent allowance/)).toBeDefined()
  })

  it('renders empty and error states', () => {
    mockUseCatalog.mockReturnValue({ entries: [], loading: false, error: null })
    const { unmount } = render(<CatalogPanel />)
    expect(screen.getByText('No services listed yet')).toBeDefined()
    unmount()

    mockUseCatalog.mockReturnValue({ entries: [], loading: false, error: 'boom' })
    render(<CatalogPanel />)
    expect(screen.getByText('Could not load the catalog')).toBeDefined()
  })

  function twoChainCatalog() {
    mockUseCatalog.mockReturnValue({
      entries: [
        entry({ id: 'base-1', name: 'Base service', network: 'eip155:8453' }),
        entry({ id: 'sep-1', name: 'Sepolia service', network: 'eip155:84532' }),
      ],
      loading: false,
      error: null,
    })
  }

  it('defaults to the active chain and offers a network override', () => {
    twoChainCatalog() // active chain = Base (beforeEach)
    render(<CatalogPanel />)

    expect(screen.getByText('Base service')).toBeDefined()
    expect(screen.queryByText('Sepolia service')).toBeNull()
    // The override dropdown is offered because more than one chain is present.
    expect(screen.getByLabelText('Filter catalog by network')).toBeDefined()
  })

  it('overrides to another chain, then to all networks', () => {
    twoChainCatalog()
    render(<CatalogPanel />)
    const select = screen.getByLabelText('Filter catalog by network')

    fireEvent.change(select, { target: { value: '84532' } })
    expect(screen.getByText('Sepolia service')).toBeDefined()
    expect(screen.queryByText('Base service')).toBeNull()

    fireEvent.change(select, { target: { value: 'all' } })
    expect(screen.getByText('Base service')).toBeDefined()
    expect(screen.getByText('Sepolia service')).toBeDefined()
  })

  it('re-defaults to the active chain when it switches', () => {
    twoChainCatalog()
    const { rerender } = render(<CatalogPanel />)
    expect(screen.getByText('Base service')).toBeDefined()
    expect(screen.queryByText('Sepolia service')).toBeNull()

    // Flip the active account to a Sepolia one — catalog follows.
    mockUseAuth.mockReturnValue({ activeSafe: { id: 's2', chain_id: 84532 } })
    rerender(<CatalogPanel />)
    expect(screen.getByText('Sepolia service')).toBeDefined()
    expect(screen.queryByText('Base service')).toBeNull()
  })

  it('shows an escape hatch when the active chain has no services', () => {
    // Active chain = Gnosis (100), but the catalog only has Base entries.
    mockUseAuth.mockReturnValue({ activeSafe: { id: 's3', chain_id: 100 } })
    mockUseCatalog.mockReturnValue({
      entries: [entry({ id: 'base-1', name: 'Base service', network: 'eip155:8453' })],
      loading: false,
      error: null,
    })
    render(<CatalogPanel />)

    expect(screen.getByText('No services on Gnosis Chain yet')).toBeDefined()
    fireEvent.click(screen.getByText('View all networks'))
    expect(screen.getByText('Base service')).toBeDefined()
  })
})
