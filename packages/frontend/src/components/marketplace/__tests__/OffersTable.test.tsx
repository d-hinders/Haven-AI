import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { OffersTable } from '../OffersTable'
import { agentInstruction, ANY_RECIPIENT_BUDGET_TAG } from '@/lib/marketplace'
import type { CatalogEntry } from '@/hooks/useCatalog'

/**
 * The merchant page's single offers list (#3981). The deleted
 * `PayWithHavenBlock.test.tsx` guarded the payment note and the per-offer
 * tag here — the block folded into this section — and the old guards on the
 * per-row Verified badge and the Method column are rewritten as their
 * absences. The `agentInstruction` string itself is guarded byte-for-byte in
 * `lib/__tests__/marketplace.test.ts` and is NOT retested here; what IS
 * tested is that the labelled copy button carries it, and when it is printed
 * (#3998: only when the user must edit it, or after a refused copy).
 *
 * NOTE the fixture: `offer()` defaults to an MCP offer WITH a tool, the one
 * branch whose instruction stays printed. A test about the copy-only rows
 * must override it — `plain()` below.
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
    tool_arguments_schema: null,
    http_method: null,
    body_type: null,
    body_example: null,
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

/** A copy-only offer: plain HTTP x402, no tool — its instruction is never printed unasked. */
function plain(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return offer({
    protocol: 'http',
    tool_name: null,
    resource_url: 'https://services.example/api/fact',
    name: 'Fact',
    ...overrides,
  })
}

const oneAgent = [
  { status: 'active', allowances: [{ token_symbol: 'USDC', allowance_amount: '25.00' }] },
]

function row(id: string) {
  return within(screen.getByTestId(`offer-row-${id}`))
}

beforeEach(() => {
  // The copy button writes through `navigator.clipboard`; jsdom ships none.
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  })
})

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

  it('has no Method column and no per-row Verified badge — the method survives inside the instruction', () => {
    render(
      <OffersTable
        offers={[offer({ id: 'mcp' }), offer({ id: 'unproved', verified_payable: true })]}
        agents={[]}
      />,
    )
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).not.toContain('Method')
    // The trust claim lives once, in the merchant header — never per row.
    expect(screen.queryByText('Verified')).toBeNull()
    // The MCP tool name — the old Method cell — is still on screen, inside
    // the instruction the user pastes.
    expect(screen.getAllByText('Pay https://mcp.text.example/mcp via create_text for <what you want>').length).toBeGreaterThan(0)
  })

  // #3998: one row per offer — the instruction is no longer a second row.
  it('renders ONE table row per offer, plus only the disclosure row when other networks exist', () => {
    render(
      <OffersTable
        offers={[
          plain({ id: 'a', network: 'eip155:84532' }),
          plain({ id: 'b', network: 'eip155:84532', name: 'Joke' }),
          plain({ id: 'c', network: 'eip155:8453', name: 'Quote' }),
        ]}
        agents={[]}
        defaultChainId={84532}
      />,
    )
    const tbody = screen.getByTestId('offers-table').querySelector('tbody')!
    // Two visible offers + the "Other networks" disclosure row.
    expect(tbody.querySelectorAll(':scope > tr')).toHaveLength(3)
    // The nested table inside the disclosure: one row for its one offer.
    const nested = within(screen.getAllByTestId('other-networks')[1]).getByRole('table')
    expect(nested.querySelectorAll('tbody > tr')).toHaveLength(1)
  })

  it.each([
    ['plain HTTP x402', plain({ id: 'http' })],
    ['machine-payment (mpp)', plain({ id: 'mpp', rail: 'mpp' })],
    ['MCP without a tool', plain({ id: 'mcp-bare', protocol: 'mcp', tool_name: null })],
  ])('does not print the instruction of a copy-only offer (%s); the meta line shows where and how fresh', (_kind, entry) => {
    render(<OffersTable offers={[entry]} agents={[]} />)
    expect(screen.queryByText(agentInstruction(entry))).toBeNull()
    const meta = row(entry.id).getByTitle(entry.resource_url)
    expect(meta.textContent).toBe('services.example/api/fact · verified just now')
    expect(meta.className).toContain('truncate')
  })

  it('copies the exact instruction from a labelled button whose name keeps its visible words, then reads "Copied"', async () => {
    const entry = plain()
    render(<OffersTable offers={[entry]} agents={[]} />)
    const button = row(entry.id).getByRole('button', { name: 'Copy instruction for Fact' })
    expect(button.textContent).toBe('Copy instruction')
    fireEvent.click(button)
    await vi.waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(agentInstruction(entry))
    })
    expect((await row(entry.id).findByRole('button', { name: 'Instruction for Fact copied' })).textContent).toBe('Copied')
  })

  it('keeps an instruction with a placeholder printed in the Offer cell, with the hint, wrapping not truncating', () => {
    render(<OffersTable offers={[offer()]} agents={[]} />)
    const printed = row('offer-1').getByText(agentInstruction(offer()))
    expect(printed.className).not.toContain('truncate')
    expect(printed.className).toContain('break-all')
    expect(row('offer-1').getByText('Replace <what you want> before sending.')).toBeDefined()
  })

  it('reveals a copy-only instruction when the clipboard refuses it — row and card alike', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    })
    const entry = plain()
    render(<OffersTable offers={[entry]} agents={[]} />)
    expect(screen.queryByText(agentInstruction(entry))).toBeNull()
    fireEvent.click(row(entry.id).getByRole('button', { name: 'Copy instruction for Fact' }))
    await vi.waitFor(() => {
      expect(row(entry.id).getByText(agentInstruction(entry))).toBeDefined()
    })
    expect(row(entry.id).getByText(/Copying was blocked/)).toBeDefined()
    const card = within(screen.getByTestId(`offer-card-${entry.id}`))
    expect(card.queryByText(agentInstruction(entry))).toBeNull()
    fireEvent.click(card.getByRole('button', { name: 'Copy instruction for Fact' }))
    await vi.waitFor(() => {
      expect(card.getByText(agentInstruction(entry))).toBeDefined()
    })
  })

  it('renders the payment note once when every offer needs an any-recipient budget, and never when none does', () => {
    const { unmount } = render(<OffersTable offers={[offer(), offer({ id: 'o-2' })]} agents={[]} />)
    expect(screen.getAllByText(/budget that can pay any recipient/)).toHaveLength(1)
    expect(screen.queryByText(ANY_RECIPIENT_BUDGET_TAG)).toBeNull()
    unmount()
    render(
      <OffersTable
        offers={[offer({ asset_transfer_methods: 'eip3009,erc7710' }), offer({ id: 'o-2', asset_transfer_methods: 'eip3009,erc7710' })]}
        agents={[]}
      />,
    )
    expect(screen.queryByText(/budget that can pay any recipient/)).toBeNull()
  })

  it('tags only the offers that need it when the merchant is mixed', () => {
    render(
      <OffersTable
        offers={[offer(), offer({ id: 'o-2', asset_transfer_methods: 'eip3009,erc7710' })]}
        agents={[]}
      />,
    )
    expect(screen.getAllByText(/budget that can pay any recipient/)).toHaveLength(1)
    expect(screen.getAllByText(/Offers marked "any-recipient budget" need this/)).toHaveLength(1)
    expect(row('offer-1').getByText(ANY_RECIPIENT_BUDGET_TAG)).toBeDefined()
    expect(row('o-2').queryByText(ANY_RECIPIENT_BUDGET_TAG)).toBeNull()
    // The banned protocol jargon never reaches the page.
    expect(document.body.textContent).not.toContain('EIP-3009')
    expect(document.body.textContent).not.toContain('unpinned')
  })

  it('shows the offers on the user’s network first and the rest behind an "Other networks (n)" disclosure, once per shape', () => {
    const sepolia = [offer({ id: 's1' }), offer({ id: 's2' }), offer({ id: 's3' })]
    const base = [offer({ id: 'b1', network: 'eip155:8453' }), offer({ id: 'b2', network: 'eip155:8453' }), offer({ id: 'b3', network: 'eip155:8453' })]
    render(<OffersTable offers={[...sepolia, ...base]} agents={[]} defaultChainId={84532} />)
    // The disclosure carries the count of the OTHER networks' offers.
    expect(screen.getAllByText('Other networks (3)')).toHaveLength(2)
    // Each offer id appears exactly once per shape — desktop row and phone
    // card — with every disclosure expanded (jsdom renders details children).
    for (const id of ['s1', 's2', 's3', 'b1', 'b2', 'b3']) {
      expect(screen.getAllByTestId(`offer-row-${id}`)).toHaveLength(1)
      expect(screen.getAllByTestId(`offer-card-${id}`)).toHaveLength(1)
    }
    // The user's own network's offers sit OUTSIDE the disclosure.
    expect(within(screen.getByTestId('offers-table')).getByTestId('offer-row-s1')).toBeDefined()
  })

  it('renders every offer flat when the user’s default network serves none of the merchant’s offers', () => {
    render(
      <OffersTable offers={[offer({ id: 'a', network: 'eip155:84532' }), offer({ id: 'b', network: 'eip155:8453' })]} agents={[]} defaultChainId={null} />,
    )
    expect(screen.queryByText(/Other networks/)).toBeNull()
    expect(screen.getAllByTestId('offer-row-a')).toHaveLength(1)
    expect(screen.getAllByTestId('offer-row-b')).toHaveLength(1)
  })

  it('renders the same offers as stacked cards for phone widths, budget hint and labelled copy button included', () => {
    render(
      <OffersTable
        offers={[offer({ id: 'within' }), offer({ id: 'above', name: 'Bulk video render', price_atomic: '99000000', price_display: '$99.00 USDC' })]}
        agents={oneAgent}
      />,
    )
    const list = screen.getByTestId('offers-list')
    expect(list.className).toContain('md:hidden')
    expect(screen.getByTestId('offers-table').className).toMatch(/\bhidden\b.*md:block/)
    const above = within(screen.getByTestId('offer-card-above'))
    expect(above.getByText('Above every agent budget — a payment would be declined')).toBeDefined()
    expect(above.getByText('Base Sepolia')).toBeDefined()
    expect(above.getByText('Pay https://mcp.text.example/mcp via create_text for <what you want>')).toBeDefined()
    expect(within(screen.getByTestId('offer-card-within')).getByText('Within your agent budget')).toBeDefined()
    // One labelled button per shape: the desktop row and the phone card.
    expect(screen.getAllByRole('button', { name: 'Copy instruction for Bulk video render' })).toHaveLength(2)
  })
})
