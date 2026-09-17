import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { OffersTable } from '../OffersTable'
import type { CatalogEntry } from '@/hooks/useCatalog'

/**
 * The offers table's render branches (#3079). The deleted
 * `CatalogPanel.test.tsx` guarded the degraded badge, the over-budget warning
 * and the verified badge on the old card; those guards live here now, against
 * the row that replaced it — plus the three budget states in ONE frame, the
 * chain-NAME network cell and the MCP method/path split.
 */
function offer(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'offer-1',
    name: 'Text generation',
    description: 'Generate short-form text.',
    category: 'media',
    resource_url: 'https://mcp.text.example/mcp',
    merchant: { id: 'm-1', slug: 'text', name: 'Text Co', listing_status: 'live', is_test_merchant: false },
    rail: 'x402',
    protocol: 'mcp',
    tool_name: 'create_text',
    tool_arguments: null,
    price_display: '$0.01 USDC',
    price_atomic: '10000',
    asset: 'USDC',
    network: 'eip155:84532',
    asset_transfer_methods: null,
    status: 'active',
    verified_at: new Date().toISOString(),
    source: 'operator',
    domain_verified: false,
    verified_payable: false,
    ...overrides,
  }
}

const oneAgent = [
  { status: 'active', allowances: [{ token_symbol: 'USDC', allowance_amount: '25.00' }] },
]

function row(id: string) {
  return within(screen.getByTestId(`offer-row-${id}`))
}

describe('OffersTable', () => {
  it('renders all three budget states in one frame: answer, answer, absence', () => {
    render(
      <OffersTable
        offers={[
          offer({ id: 'within' }),
          offer({ id: 'above', name: 'Bulk video render', price_atomic: '99000000', price_display: '$99.00 USDC' }),
          offer({ id: 'unknown', name: 'Currency reference', asset: 'EURe', price_atomic: '500000000000000000', price_display: '€0.50 EURe' }),
        ]}
        agents={oneAgent}
      />,
    )
    expect(row('within').getByText('Within your agent budget')).toBeDefined()
    expect(row('above').getByText('Above every agent budget — a payment would be declined')).toBeDefined()
    // Positive control for the absence: the row rendered, with neither line.
    expect(row('unknown').getByText('Currency reference')).toBeDefined()
    expect(row('unknown').queryByText(/agent budget/)).toBeNull()
  })

  it('keeps a degraded offer usable with the badge and a calm availability note, and only there', () => {
    render(<OffersTable offers={[offer({ id: 'ok' }), offer({ id: 'down', status: 'degraded' })]} agents={[]} />)
    expect(row('down').getByText('Limited availability')).toBeDefined()
    expect(row('down').getByText(/Recently unreachable on our checks/)).toBeDefined()
    expect(row('down').getByText('$0.01 USDC')).toBeDefined()
    expect(row('ok').queryByText('Limited availability')).toBeNull()
    expect(row('ok').queryByText(/Recently unreachable/)).toBeNull()
  })

  it('shows the Verified badge exactly when the entry is verified payable, with the honest claim', () => {
    render(
      <OffersTable
        offers={[offer({ id: 'proved', verified_payable: true }), offer({ id: 'unproved', source: 'ingestion' })]}
        agents={[]}
      />,
    )
    expect(row('proved').getByText('Verified')).toBeDefined()
    // Provenance alone (an ingestion row) does not earn the badge — the proof does.
    expect(row('unproved').queryByText('Verified')).toBeNull()
  })

  it('names the network and splits an MCP offer into Method (tool) and path (resource URL)', () => {
    render(
      <OffersTable
        offers={[
          offer({ id: 'mcp' }),
          offer({ id: 'http', protocol: 'http', tool_name: null, resource_url: 'https://api.example/fact', network: 'eip155:8453' }),
          offer({ id: 'nowhere', network: null }),
        ]}
        agents={[]}
      />,
    )
    expect(screen.getByRole('columnheader', { name: 'Offer' })).toBeDefined()
    expect(row('mcp').getByText('Base Sepolia')).toBeDefined()
    expect(row('mcp').getByText('create_text')).toBeDefined()
    expect(row('mcp').getByText('https://mcp.text.example/mcp')).toBeDefined()
    expect(row('http').getByText('Base')).toBeDefined()
    // The protocol is `x402` everywhere in Haven — never upper-cased.
    expect(row('http').getByText('x402')).toBeDefined()
    expect(row('http').getByText('https://api.example/fact')).toBeDefined()
    expect(row('nowhere').getByText('—')).toBeDefined()
    expect(screen.queryByText(/eip155:/)).toBeNull()
  })
})
