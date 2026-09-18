import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PayWithHavenBlock, UNPINNED_BUDGET_NOTE } from '../PayWithHavenBlock'
import type { CatalogEntry } from '@/hooks/useCatalog'

function offer(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'o-1',
    name: 'Fact',
    description: 'Returns one random fact.',
    category: 'api',
    resource_url: 'https://services.sandbox.ampersend.ai/api/fact',
    merchant: { id: 'm-1', slug: 'ampersend', name: 'Ampersend', listing_status: 'live', is_test_merchant: false },
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

describe('PayWithHavenBlock', () => {
  it('labels every instruction with its offer and price, and prints the instruction in full', () => {
    render(<PayWithHavenBlock offers={[offer(), offer({ id: 'o-2', name: 'Joke', resource_url: 'https://services.sandbox.ampersend.ai/api/joke' })]} />)
    const fact = within(screen.getByTestId('pay-block-o-1'))
    expect(fact.getByText('Fact')).toBeDefined()
    expect(fact.getByText('$0.001 USDC')).toBeDefined()
    const code = fact.getByText('Pay https://services.sandbox.ampersend.ai/api/fact and return the result')
    expect(code.className).not.toContain('truncate')
    expect(code.className).toContain('break-all')
    expect(within(screen.getByTestId('pay-block-o-2')).getByText('Joke')).toBeDefined()
  })

  it('renders the EIP-3009 note once when every offer needs an unpinned budget, and never when none does', () => {
    const { unmount } = render(<PayWithHavenBlock offers={[offer(), offer({ id: 'o-2' })]} />)
    expect(screen.getAllByText(UNPINNED_BUDGET_NOTE)).toHaveLength(1)
    expect(screen.queryByText('unpinned budget')).toBeNull()
    unmount()
    render(<PayWithHavenBlock offers={[offer({ asset_transfer_methods: 'eip3009,erc7710' })]} />)
    expect(screen.queryByText(/EIP-3009/)).toBeNull()
  })

  it('tags only the offers that need it when the merchant is mixed', () => {
    render(<PayWithHavenBlock offers={[offer(), offer({ id: 'o-2', asset_transfer_methods: 'eip3009,erc7710' })]} />)
    expect(screen.getAllByText(/EIP-3009/)).toHaveLength(1)
    expect(within(screen.getByTestId('pay-block-o-1')).getByText('unpinned budget')).toBeDefined()
    expect(within(screen.getByTestId('pay-block-o-2')).queryByText('unpinned budget')).toBeNull()
  })
})
