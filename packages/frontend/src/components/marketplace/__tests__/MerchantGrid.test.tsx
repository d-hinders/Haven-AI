import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MerchantGrid } from '../MerchantGrid'
import { verifiedMeaning } from '@/lib/marketplace'
import type { Merchant } from '@/hooks/useCatalog'

function merchant(overrides: Partial<Merchant> = {}): Merchant {
  return {
    id: 'm-1',
    slug: 'merchant-one',
    name: 'Merchant One',
    description: 'Sells things.',
    website: 'https://merchant-one.example',
    logo_url: null,
    category: 'api',
    country: null,
    listing_status: 'live',
    is_test_merchant: false,
    offer_count: 2,
    networks: ['eip155:8453'],
    verified_payable: false,
    lowest_price_atomic: '1000',
    ...overrides,
  }
}

/** The rendered merchant cards, in DOM order. */
function cardSlugs(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid^="merchant-card-"]')].map((el) =>
    (el.getAttribute('data-testid') ?? '').replace('merchant-card-', ''),
  )
}

describe('MerchantGrid', () => {
  it('renders empty and error states', () => {
    const { unmount } = render(
      <MerchantGrid merchants={[]} loading={false} error={null} onSubmit={vi.fn()} />,
    )
    expect(screen.getByText('No merchants listed yet')).toBeDefined()
    unmount()

    render(<MerchantGrid merchants={[]} loading={false} error="boom" onSubmit={vi.fn()} />)
    expect(screen.getByText('Could not load the marketplace')).toBeDefined()
  })

  it('renders the card on the entity-card idiom with the product focus ring, footer pinned', () => {
    render(<MerchantGrid merchants={[merchant()]} loading={false} error={null} onSubmit={vi.fn()} />)
    const card = screen.getByTestId('merchant-card-merchant-one')
    expect(card.className).toContain('focus-visible:ring-2')
    expect(card.className).toContain('shadow-card')
    expect(card.querySelector('.mt-auto')).not.toBeNull()
  })

  it('renders a merchant card with category, description, footer and networks (#3980: From <price> USDC first, the count after it)', () => {
    render(
      <MerchantGrid
        merchants={[merchant()]}
        loading={false}
        error={null}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.getByTestId('merchant-card-merchant-one')).toBeDefined()
    expect(screen.getByText('Merchant One')).toBeDefined()
    // Two offers: the lowest USDC price leads ("From 0.001 USDC" — 1000
    // atomic, 6 decimals), the offer count follows it.
    expect(screen.getByText('From 0.001 USDC · 2 offers')).toBeDefined()
  })

  it('shows the offer count alone when no counted offer prices in USDC', () => {
    render(
      <MerchantGrid
        merchants={[merchant({ lowest_price_atomic: null })]}
        loading={false}
        error={null}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.getByText('2 offers')).toBeDefined()
    expect(screen.queryByText(/From /)).toBeNull()
  })

  it('renders a coming-soon card muted: "Coming soon" in the badge slot and no offer or price footer', () => {
    render(
      <MerchantGrid
        merchants={[merchant({ id: 's', slug: 'soon', name: 'Soon Co', listing_status: 'coming_soon' })]}
        loading={false}
        error={null}
        onSubmit={vi.fn()}
      />,
    )
    const card = screen.getByTestId('merchant-card-soon')
    expect(within(card).getByText('Coming soon')).toBeDefined()
    expect(within(card).queryByText(/offer/)).toBeNull()
    expect(within(card).queryByText(/From /)).toBeNull()
  })

  it('sorts payable merchants before coming-soon ones, keeping the served order inside each group', () => {
    // Exactly `GET /merchants`' order (coming_soon sorts before `live`
    // alphabetically, so Berget and Redpine head the raw list) — the grid
    // must not present a card you cannot pay before one you can, while the
    // endpoint's own order stays untouched for its other clients.
    const served = [
      merchant({ id: 'b', slug: 'berget-ai', name: 'Berget AI', listing_status: 'coming_soon' }),
      merchant({ id: 'r', slug: 'redpine', name: 'Redpine', listing_status: 'coming_soon' }),
      // A testnet network so the "Show test merchants" default is ON and the
      // test merchant's card is on the page at all.
      merchant({ id: 't', slug: 'test-one', name: 'Aaa test', is_test_merchant: true, networks: ['eip155:84532'] }),
      merchant({ id: 'z', slug: 'zzz', name: 'Zzz live' }),
    ]
    const { container } = render(<MerchantGrid merchants={served} loading={false} error={null} onSubmit={vi.fn()} />)
    expect(cardSlugs(container)).toEqual(['zzz', 'test-one', 'berget-ai', 'redpine'])
  })

  it('marks a verified merchant with the quiet check — title carries the meaning, sr-only the word, and no uppercase badge', () => {
    render(
      <MerchantGrid
        merchants={[merchant({ id: 'v', slug: 'verified', verified_payable: true })]}
        loading={false}
        error={null}
        onSubmit={vi.fn()}
      />,
    )
    const card = screen.getByTestId('merchant-card-verified')
    // The quiet marker: `title` spells the meaning out on hover/AT, sr-only
    // "Verified" names it, and the uppercase badge is gone.
    expect(within(card).getByTitle(verifiedMeaning('Merchant One'))).toBeDefined()
    expect(within(card).getByText('Verified').className).toContain('sr-only')
    expect(within(card).queryByText('VERIFIED')).toBeNull()
    // The unverified card carries no marker at all.
    const { unmount } = render(<MerchantGrid merchants={[merchant()]} loading={false} error={null} onSubmit={vi.fn()} />)
    expect(screen.getByTestId('merchant-card-merchant-one').querySelector('[title]')).toBeNull()
    unmount()
  })

  it('shows the test-merchant footer label and hides it behind the toggle by default when no listed network is a testnet', () => {
    const merchants = [
      merchant({ id: 't', slug: 'test-one', is_test_merchant: true, networks: ['eip155:8453'] }),
    ]
    render(<MerchantGrid merchants={merchants} loading={false} error={null} onSubmit={vi.fn()} />)
    // Mainnet-only data: the toggle defaults OFF, so the card starts hidden.
    expect(screen.queryByTestId('merchant-card-test-one')).toBeNull()
    fireEvent.click(screen.getByLabelText('Show test merchants'))
    expect(screen.getByTestId('merchant-card-test-one')).toBeDefined()
    expect(screen.getByText('A Haven test merchant: payments are real (small amounts of USDC), but what you get is demo content.')).toBeDefined()
  })

  it('derives the "Show test merchants" default from data that arrives AFTER mount — the grid mounts on an empty list', () => {
    // The baseline harness saw the demo store hidden with a testnet listed:
    // a `useState(default)` captured `false` on the empty first render.
    // The real mount order: loading over an empty list, then the data.
    const { rerender } = render(<MerchantGrid merchants={[]} loading={true} error={null} onSubmit={() => {}} />)
    expect(screen.queryByLabelText('Show test merchants')).toBeNull()
    // The loading shell is marked busy: the skeletons are aria-hidden, and
    // the capture harness's content floor must not certify this frame.
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true')
    rerender(<MerchantGrid merchants={[merchant({ networks: ['eip155:84532'] }), merchant({ id: 'm-test', slug: 'haven-demo-store', name: 'Haven Demo Store', is_test_merchant: true, networks: ['eip155:84532'] })]} loading={false} error={null} onSubmit={() => {}} />)
    expect(screen.getByLabelText('Show test merchants')).toBeChecked()
    // A user's click still wins over the derived default afterwards.
    fireEvent.click(screen.getByLabelText('Show test merchants'))
    expect(screen.getByLabelText('Show test merchants')).not.toBeChecked()
    rerender(<MerchantGrid merchants={[merchant({ networks: ['eip155:84532'] }), merchant({ id: 'm-test', slug: 'haven-demo-store', name: 'Haven Demo Store', is_test_merchant: true, networks: ['eip155:84532'] })]} loading={false} error={null} onSubmit={() => {}} />)
    expect(screen.getByLabelText('Show test merchants')).not.toBeChecked()
  })

  it('defaults "Show test merchants" on when any listed network is a testnet', () => {
    const merchants = [
      merchant({ id: 't', slug: 'test-one', is_test_merchant: true, networks: ['eip155:84532'] }),
    ]
    render(<MerchantGrid merchants={merchants} loading={false} error={null} onSubmit={vi.fn()} />)
    expect(screen.getByLabelText('Show test merchants')).toBeChecked()
    expect(screen.getByTestId('merchant-card-test-one')).toBeDefined()
  })

  it('defaults on when ONLY SOME listed merchants are on a testnet (kills a some->every mutant)', () => {
    // One mainnet-only merchant and one testnet merchant: `.some` says ON,
    // `.every` would say OFF — the two disagree only on a mixed set like this.
    const merchants = [
      merchant({ id: 'mainnet', slug: 'mainnet-one', networks: ['eip155:8453'] }),
      merchant({
        id: 't',
        slug: 'test-one',
        is_test_merchant: true,
        networks: ['eip155:84532'],
      }),
    ]
    render(<MerchantGrid merchants={merchants} loading={false} error={null} onSubmit={vi.fn()} />)
    expect(screen.getByLabelText('Show test merchants')).toBeChecked()
    expect(screen.getByTestId('merchant-card-test-one')).toBeDefined()
  })

  it('shows the network dropdown only when more than one chain is listed', () => {
    const { rerender } = render(
      <MerchantGrid merchants={[merchant()]} loading={false} error={null} onSubmit={vi.fn()} />,
    )
    expect(screen.queryByLabelText('Filter marketplace by network')).toBeNull()

    rerender(
      <MerchantGrid
        merchants={[
          merchant({ id: 'a', slug: 'a', networks: ['eip155:8453'] }),
          merchant({ id: 'b', slug: 'b', networks: ['eip155:84532'] }),
        ]}
        loading={false}
        error={null}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('Filter marketplace by network')).toBeDefined()
  })

  it('filters by category, search, and verified only', () => {
    const merchants = [
      merchant({ id: 'a', slug: 'media-merchant', name: 'Media Co', category: 'media' }),
      merchant({
        id: 'b',
        slug: 'data-merchant',
        name: 'Data Co',
        category: 'data',
        verified_payable: true,
      }),
    ]
    render(<MerchantGrid merchants={merchants} loading={false} error={null} onSubmit={vi.fn()} />)

    const categoryGroup = screen.getByRole('group', { name: 'Filter by category' })
    fireEvent.click(within(categoryGroup).getByRole('button', { name: 'Data' }))
    expect(screen.queryByText('Media Co')).toBeNull()
    expect(screen.getByText('Data Co')).toBeDefined()

    fireEvent.click(within(categoryGroup).getByRole('button', { name: 'All' }))
    fireEvent.click(screen.getByLabelText('Verified only'))
    expect(screen.queryByText('Media Co')).toBeNull()
    expect(screen.getByText('Data Co')).toBeDefined()

    fireEvent.click(screen.getByLabelText('Verified only'))
    fireEvent.change(screen.getByLabelText('Search merchants'), { target: { value: 'media' } })
    expect(screen.getByText('Media Co')).toBeDefined()
    expect(screen.queryByText('Data Co')).toBeNull()
  })

  it('offers a retry on a failed load, and hides the filter row over an empty marketplace', () => {
    const onRetry = vi.fn()
    const { unmount } = render(
      <MerchantGrid merchants={[]} loading={false} error="boom" onSubmit={vi.fn()} onRetry={onRetry} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    unmount()

    render(<MerchantGrid merchants={[]} loading={false} error={null} onSubmit={vi.fn()} />)
    expect(screen.queryByLabelText('Search merchants')).toBeNull()
    expect(screen.queryByLabelText('Verified only')).toBeNull()
    expect(screen.getByRole('button', { name: 'List your service' })).toBeDefined()
  })

  it('offers "Clear filters" when a filter hides every merchant, and it restores the grid', () => {
    render(<MerchantGrid merchants={[merchant()]} loading={false} error={null} onSubmit={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Search merchants'), { target: { value: 'nothing here' } })
    expect(screen.getByText('No merchants match this filter')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(screen.getByText('Merchant One')).toBeDefined()
    expect((screen.getByLabelText('Search merchants') as HTMLInputElement).value).toBe('')
  })

  it('honours a deep-linked category and labels acronym categories as acronyms', () => {
    render(
      <MerchantGrid
        merchants={[merchant({ id: 'a', slug: 'a', name: 'A Co', category: 'api' }), merchant({ id: 'b', slug: 'b', name: 'B Co', category: 'ai' })]}
        loading={false}
        error={null}
        onSubmit={vi.fn()}
        initialCategory="ai"
      />,
    )
    expect(screen.getByText('B Co')).toBeDefined()
    expect(screen.queryByText('A Co')).toBeNull()
    const group = screen.getByRole('group', { name: 'Filter by category' })
    expect(within(group).getByRole('button', { name: 'AI' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(group).getByRole('button', { name: 'API' })).toBeDefined()
  })

  it('opens the submit modal from the empty marketplace', () => {
    const onSubmit = vi.fn()
    render(<MerchantGrid merchants={[]} loading={false} error={null} onSubmit={onSubmit} />)
    fireEvent.click(screen.getByRole('button', { name: 'List your service' }))
    expect(onSubmit).toHaveBeenCalled()
  })

  // #3979: on a populated grid, listing a service is a note for sellers below
  // the cards — not a button in the buyer's toolbar.
  it('opens the submit modal from the seller note below a populated grid, not from the toolbar', () => {
    const onSubmit = vi.fn()
    render(<MerchantGrid merchants={[merchant()]} loading={false} error={null} onSubmit={onSubmit} />)
    // One entry point, below the cards — none in the toolbar.
    expect(screen.getAllByRole('button', { name: 'List your service' })).toHaveLength(1)
    const note = screen.getByTestId('marketplace-list-service')
    expect(within(note).getByText('Sell an API or MCP tool?')).toBeDefined()
    fireEvent.click(within(note).getByRole('button', { name: 'List your service' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('puts the search field and the network dropdown on one row, the search with a leading icon', () => {
    render(
      <MerchantGrid
        merchants={[
          merchant({ id: 'a', slug: 'a', networks: ['eip155:8453'] }),
          merchant({ id: 'b', slug: 'b', networks: ['eip155:84532'] }),
        ]}
        loading={false}
        error={null}
        onSubmit={vi.fn()}
      />,
    )
    const search = screen.getByLabelText('Search merchants')
    const field = search.closest('div.relative') as HTMLElement
    expect(search.className).toContain('pl-9')
    expect(field.querySelector('svg')).not.toBeNull()
    expect(within(field.parentElement!.parentElement!).getByLabelText('Filter marketplace by network')).toBeDefined()
  })

  describe('default network (#3979)', () => {
    const twoChains = [
      merchant({ id: 'base', slug: 'base-only', name: 'Base Co', networks: ['eip155:8453'] }),
      merchant({ id: 'sep', slug: 'sepolia-only', name: 'Sepolia Co', networks: ['eip155:84532'] }),
      merchant({ id: 'soon', slug: 'coming-soon', name: 'Soon Co', listing_status: 'coming_soon', networks: [] }),
    ]
    const select = () => screen.getByLabelText('Filter marketplace by network') as HTMLSelectElement

    it("opens on the user's network and keeps network-less merchants visible", () => {
      render(
        <MerchantGrid merchants={twoChains} loading={false} error={null} onSubmit={vi.fn()} defaultChainId={84532} />,
      )
      expect(select().value).toBe('84532')
      expect(screen.getByText('Sepolia Co')).toBeDefined()
      expect(screen.queryByText('Base Co')).toBeNull()
      // Coming soon (and ingestion-only) merchants list no network: no filter hides them.
      expect(screen.getByText('Soon Co')).toBeDefined()
    })

    it('derives the default from a user and merchants that arrive AFTER mount', () => {
      const { rerender } = render(
        <MerchantGrid merchants={[]} loading={true} error={null} onSubmit={vi.fn()} defaultChainId={null} />,
      )
      rerender(
        <MerchantGrid merchants={twoChains} loading={false} error={null} onSubmit={vi.fn()} defaultChainId={null} />,
      )
      expect(select().value).toBe('all')
      rerender(
        <MerchantGrid merchants={twoChains} loading={false} error={null} onSubmit={vi.fn()} defaultChainId={84532} />,
      )
      expect(select().value).toBe('84532')
      expect(screen.queryByText('Base Co')).toBeNull()
    })

    it('falls back to All networks when the user has no account on a listed chain', () => {
      render(
        <MerchantGrid merchants={twoChains} loading={false} error={null} onSubmit={vi.fn()} defaultChainId={1} />,
      )
      expect(select().value).toBe('all')
      expect(screen.getByText('Base Co')).toBeDefined()
      expect(screen.getByText('Sepolia Co')).toBeDefined()
    })

    it('lets a choice override the default, and Clear filters goes to All networks', () => {
      render(
        <MerchantGrid merchants={twoChains} loading={false} error={null} onSubmit={vi.fn()} defaultChainId={84532} />,
      )
      fireEvent.change(select(), { target: { value: 'all' } })
      expect(screen.getByText('Base Co')).toBeDefined()

      fireEvent.change(select(), { target: { value: '84532' } })
      fireEvent.change(screen.getByLabelText('Search merchants'), { target: { value: 'base' } })
      expect(screen.getByText('No merchants match this filter')).toBeDefined()
      fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
      expect(select().value).toBe('all')
      expect(screen.getByText('Base Co')).toBeDefined()
    })
  })

  describe('test content has one control (#3979)', () => {
    const withFixture = [
      merchant({ id: 'a', slug: 'api-one', name: 'API Co', category: 'api' }),
      merchant({ id: 'd', slug: 'data-one', name: 'Data Co', category: 'data' }),
      merchant({
        id: 'f',
        slug: 'minifetch',
        name: 'Minifetch',
        category: 'test-fixture',
        is_test_merchant: true,
        networks: ['eip155:84532'],
      }),
    ]

    it('renders no Test-fixture pill; the checkbox alone shows and hides test merchants', () => {
      render(<MerchantGrid merchants={withFixture} loading={false} error={null} onSubmit={vi.fn()} />)
      const group = screen.getByRole('group', { name: 'Filter by category' })
      expect(within(group).queryByRole('button', { name: /test/i })).toBeNull()
      expect(within(group).getByRole('button', { name: 'Data' })).toBeDefined()
      expect(screen.getByText('Minifetch')).toBeDefined()
      fireEvent.click(screen.getByLabelText('Show test merchants'))
      expect(screen.queryByText('Minifetch')).toBeNull()
    })

    it('opens a ?category=test-fixture deep link as All, so no filter is active without a pill', () => {
      render(
        <MerchantGrid
          merchants={withFixture}
          loading={false}
          error={null}
          onSubmit={vi.fn()}
          initialCategory="test-fixture"
        />,
      )
      const group = screen.getByRole('group', { name: 'Filter by category' })
      expect(within(group).getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true')
      expect(screen.getByText('API Co')).toBeDefined()
    })
  })
})
