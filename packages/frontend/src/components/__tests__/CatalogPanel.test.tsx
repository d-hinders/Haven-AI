import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockUseCatalog, mockUseAgents } = vi.hoisted(() => ({
  mockUseCatalog: vi.fn(),
  mockUseAgents: vi.fn(),
}))

vi.mock('@/hooks/useCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useCatalog')>()
  return { ...actual, useCatalog: () => mockUseCatalog() }
})

vi.mock('@/hooks/useAgents', () => ({
  useAgents: () => mockUseAgents(),
}))

import CatalogPanel, { agentInstruction, withinBudget } from '../CatalogPanel'
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

describe('CatalogPanel', () => {
  beforeEach(() => {
    mockUseAgents.mockReturnValue({ agents: [activeAgent] })
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
})
