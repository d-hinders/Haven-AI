import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MerchantGrid } from '../MerchantGrid'
import { verifiedMeaning } from '@/lib/marketplace'
import { TEST_MERCHANT_NOTE } from '../MerchantHeader'
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

/** The coming-soon section's rows (#4052), in DOM order. */
function rowSlugs(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid^="merchant-row-"]')].map((el) =>
    (el.getAttribute('data-testid') ?? '').replace('merchant-row-', ''),
  )
}

/**
 * The footer's two spans (#4052): the price leads in ink and semibold, the
 * offer count after it stays ink-3 (inherited from the footer line).
 */
function expectFooter(card: HTMLElement, price: string, count: string | null) {
  const priceSpan = within(card).getByText(`From ${price} USDC`, { exact: true })
  expect(priceSpan.tagName).toBe('SPAN')
  expect(priceSpan.className).toContain('text-[var(--v2-ink)]')
  expect(priceSpan.className).toContain('font-semibold')
  const line = priceSpan.parentElement as HTMLElement
  expect(line.className).toContain('text-[var(--v2-ink-3)]')
  if (count === null) {
    expect(line.textContent).toBe(`From ${price} USDC`)
  } else {
    const countSpan = within(line).getByText(`· ${count}`, { exact: true })
    expect(countSpan.className).not.toContain('text-[var(--v2-ink)]')
    expect(line.textContent).toBe(`From ${price} USDC · ${count}`)
  }
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
    expectFooter(screen.getByTestId('merchant-card-merchant-one'), '0.001', '2 offers')
  })

  it('#4052: one offer prices alone — the whole footer is the ink price', () => {
    render(<MerchantGrid merchants={[merchant({ offer_count: 1 })]} loading={false} error={null} onSubmit={vi.fn()} />)
    expectFooter(screen.getByTestId('merchant-card-merchant-one'), '0.001', null)
  })

  it('#4008: the card and the offer row agree on the two-decimal price rule ("0.10 USDC", "1.00 USDC")', () => {
    // These are exactly the strings `price_display` carries on the wire for
    // these atomic amounts (the backend's `formatPriceDisplay`, which the
    // card now mirrors), so the grid card's footer and the merchant page's
    // offer row read the same price. Trailing zeros are trimmed down to two
    // decimals, never fewer: 0.001 stays "0.001", 0.1 renders "0.10".
    render(
      <MerchantGrid
        merchants={[
          merchant({ id: 'a', slug: 'tenth', name: 'Tenth', lowest_price_atomic: '100000' }),
          merchant({ id: 'b', slug: 'one', name: 'One', lowest_price_atomic: '1000000' }),
        ]}
        loading={false}
        error={null}
        onSubmit={vi.fn()}
      />,
    )
    expectFooter(screen.getByTestId('merchant-card-tenth'), '0.10', '2 offers')
    expectFooter(screen.getByTestId('merchant-card-one'), '1.00', '2 offers')
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
    const count = screen.getByText('2 offers')
    expect(count.className).toContain('text-[var(--v2-ink-3)]')
    expect(screen.queryByText(/From /)).toBeNull()
  })

  it('#4052: lists a coming-soon merchant as a linked row in the "Coming soon" section, never as a card', () => {
    render(
      <MerchantGrid
        merchants={[merchant({ id: 's', slug: 'soon', name: 'Soon Co', listing_status: 'coming_soon' })]}
        loading={false}
        error={null}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('merchant-card-soon')).toBeNull()
    const section = screen.getByTestId('marketplace-coming-soon')
    expect(within(section).getByRole('heading', { level: 2, name: 'Coming soon' })).toBeDefined()
    const row = within(section).getByTestId('merchant-row-soon')
    expect(within(row).getByRole('link').getAttribute('href')).toBe('/marketplace/soon')
    expect(within(row).getByText('Soon Co')).toBeDefined()
    // Nothing comparable on a merchant you cannot pay: no price, no count.
    expect(within(row).queryByText(/offer/)).toBeNull()
    expect(within(row).queryByText(/From /)).toBeNull()
    // No payable merchant is listed, yet the section is not an empty grid.
    expect(screen.queryByText('No merchants match this filter')).toBeNull()
  })

  it('#4052: renders no "Coming soon" section when no coming-soon merchant is visible', () => {
    render(<MerchantGrid merchants={[merchant()]} loading={false} error={null} onSubmit={vi.fn()} />)
    expect(screen.queryByTestId('marketplace-coming-soon')).toBeNull()
    expect(screen.queryByText('Coming soon')).toBeNull()
  })

  it('#4052: filters reach the section — search hides it, and the empty state shows only when both groups are empty', () => {
    render(
      <MerchantGrid
        merchants={[merchant(), merchant({ id: 's', slug: 'soon', name: 'Soon Co', listing_status: 'coming_soon' })]}
        loading={false}
        error={null}
        onSubmit={vi.fn()}
      />,
    )
    const search = screen.getByLabelText('Search merchants')
    // Only the payable merchant matches: the section goes, the card stays.
    fireEvent.change(search, { target: { value: 'Merchant One' } })
    expect(screen.queryByTestId('marketplace-coming-soon')).toBeNull()
    expect(screen.getByTestId('merchant-card-merchant-one')).toBeDefined()
    // Only the coming-soon merchant matches: the section stands alone, no empty state.
    fireEvent.change(search, { target: { value: 'Soon' } })
    expect(screen.queryByTestId('merchant-card-merchant-one')).toBeNull()
    expect(screen.getByTestId('merchant-row-soon')).toBeDefined()
    expect(screen.queryByText('No merchants match this filter')).toBeNull()
    // Neither matches: now, and only now, the empty state.
    fireEvent.change(search, { target: { value: 'nothing at all' } })
    expect(screen.queryByTestId('marketplace-coming-soon')).toBeNull()
    expect(screen.getByText('No merchants match this filter')).toBeDefined()
  })

  it('#4052: a category filter reaches the section — a pill with no coming-soon merchant hides it', () => {
    render(
      <MerchantGrid
        merchants={[
          merchant({ category: 'api' }),
          merchant({ id: 's', slug: 'soon', name: 'Soon Co', category: 'ai', listing_status: 'coming_soon' }),
        ]}
        loading={false}
        error={null}
        onSubmit={vi.fn()}
      />,
    )
    const pills = screen.getByRole('group', { name: 'Filter by category' })
    expect(screen.getByTestId('merchant-row-soon')).toBeDefined()
    fireEvent.click(within(pills).getByRole('button', { name: 'API' }))
    expect(screen.queryByTestId('marketplace-coming-soon')).toBeNull()
    expect(screen.getByTestId('merchant-card-merchant-one')).toBeDefined()
    fireEvent.click(within(pills).getByRole('button', { name: 'AI' }))
    expect(screen.getByTestId('merchant-row-soon')).toBeDefined()
    expect(screen.queryByTestId('merchant-card-merchant-one')).toBeNull()
  })

  it('splits payable merchants (cards) from coming-soon ones (rows after the grid), keeping the served order inside each group', () => {
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
    expect(cardSlugs(container)).toEqual(['zzz', 'test-one'])
    expect(rowSlugs(container)).toEqual(['berget-ai', 'redpine'])
    // The section comes after the grid in DOM order.
    const lastCard = screen.getByTestId('merchant-card-test-one')
    const section = screen.getByTestId('marketplace-coming-soon')
    expect(lastCard.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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
    // "Verified" names it, and the uppercase badge is gone. Asserted by
    // element and class, not text alone: CSS `uppercase` leaves the text
    // node unchanged, so only the class list proves the treatment (#4008).
    const marker = within(card).getByTitle(verifiedMeaning('Merchant One'))
    expect(marker.querySelector('svg')).not.toBeNull()
    expect(marker.className).not.toContain('uppercase')
    expect(within(marker).getByText('Verified').className).toContain('sr-only')
    expect(within(card).queryByTestId('verified-marker')).toBeNull()
    // The unverified card carries no marker at all.
    const { unmount } = render(<MerchantGrid merchants={[merchant()]} loading={false} error={null} onSubmit={vi.fn()} />)
    expect(screen.getByTestId('merchant-card-merchant-one').querySelector('[title]')).toBeNull()
    unmount()
  })

  it('#4052: marks a test merchant with a neutral "Test" badge (not the full note), hidden behind the toggle by default when no listed network is a testnet', () => {
    const merchants = [
      merchant({ id: 't', slug: 'test-one', is_test_merchant: true, networks: ['eip155:8453'] }),
    ]
    render(<MerchantGrid merchants={merchants} loading={false} error={null} onSubmit={vi.fn()} />)
    // Mainnet-only data: the toggle defaults OFF, so the card starts hidden.
    expect(screen.queryByTestId('merchant-card-test-one')).toBeNull()
    fireEvent.click(screen.getByLabelText('Show test merchants'))
    const card = screen.getByTestId('merchant-card-test-one')
    const badge = within(card).getByText('Test', { exact: true })
    expect(badge.className).toContain('rounded-full')
    expect(badge.className).not.toContain('warning')
    // The full sentence lives on the merchant page, not the grid.
    expect(screen.queryByText(TEST_MERCHANT_NOTE)).toBeNull()
    // A live, non-test card carries no badge.
    const { unmount } = render(<MerchantGrid merchants={[merchant()]} loading={false} error={null} onSubmit={vi.fn()} />)
    expect(within(screen.getByTestId('merchant-card-merchant-one')).queryByText('Test', { exact: true })).toBeNull()
    unmount()
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

  describe('#4008: the pills respect the network filter and the test toggle, not the category or search filters', () => {
    // Two categories survive a Base Sepolia filter (so the pill group renders
    // — these tests must not pass vacuously), and "media" exists ONLY on
    // Base: on dev the Media pill showed under the Base Sepolia default and
    // clicking it emptied the grid with "No merchants match this filter".
    const pool = [
      merchant({ id: 'a', slug: 'api-one', name: 'API Co', category: 'api', networks: ['eip155:84532'] }),
      merchant({ id: 'd', slug: 'data-one', name: 'Data Co', category: 'data', networks: ['eip155:84532'] }),
      merchant({ id: 'm', slug: 'media-one', name: 'Media Co', category: 'media', networks: ['eip155:8453'] }),
    ]
    const group = () => screen.getByRole('group', { name: 'Filter by category' })
    const select = () => screen.getByLabelText('Filter marketplace by network') as HTMLSelectElement

    it('shows no pill for a category the network filter has', () => {
      render(<MerchantGrid merchants={pool} loading={false} error={null} onSubmit={vi.fn()} defaultChainId={84532} />)
      expect(select().value).toBe('84532')
      expect(within(group()).getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true')
      expect(within(group()).getByRole('button', { name: 'API' })).toBeDefined()
      expect(within(group()).getByRole('button', { name: 'Data' })).toBeDefined()
      expect(within(group()).queryByRole('button', { name: 'Media' })).toBeNull()
      // And the grid itself is not emptied by the absent pill's category.
      expect(screen.getByText('API Co')).toBeDefined()
      expect(screen.getByText('Data Co')).toBeDefined()
    })

    it('brings the pill back when the network filter widens to All networks', () => {
      render(<MerchantGrid merchants={pool} loading={false} error={null} onSubmit={vi.fn()} defaultChainId={84532} />)
      fireEvent.change(select(), { target: { value: 'all' } })
      expect(within(group()).getByRole('button', { name: 'Media' })).toBeDefined()
    })

    it('resets a deep-linked category that has no pill to All, derived at read time', () => {
      // `?category=media` under the Base Sepolia default: no Media pill can
      // be visible, so the filter opens as "All" — no filter is ever active
      // without a visible pill, the rule #3979 applied to `test-fixture`.
      render(
        <MerchantGrid
          merchants={pool}
          loading={false}
          error={null}
          onSubmit={vi.fn()}
          defaultChainId={84532}
          initialCategory="media"
        />,
      )
      expect(within(group()).getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true')
      expect(screen.getByText('API Co')).toBeDefined()
      expect(screen.getByText('Data Co')).toBeDefined()
      // Media Co is hidden by the NETWORK filter, not by a dead category
      // filter nothing on screen could clear.
      expect(screen.queryByText('Media Co')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()
    })

    it('keeps a pill while only the search filter would empty its category', () => {
      // The pill pool ignores the category and search filters, so pills
      // never vanish while you are using them.
      render(<MerchantGrid merchants={pool} loading={false} error={null} onSubmit={vi.fn()} />)
      fireEvent.change(screen.getByLabelText('Search merchants'), { target: { value: 'zzz-no-hit' } })
      expect(screen.getByText('No merchants match this filter')).toBeDefined()
      expect(within(group()).getByRole('button', { name: 'Media' })).toBeDefined()
    })

    it('respects the test toggle: a category carried only by a test merchant loses its pill when the toggle is off', () => {
      const withTest = [
        merchant({ id: 'a', slug: 'api-one', name: 'API Co', category: 'api', networks: ['eip155:8453'] }),
        merchant({
          id: 't',
          slug: 'test-one',
          name: 'Test One',
          category: 'media',
          is_test_merchant: true,
          networks: ['eip155:8453'],
        }),
      ]
      render(<MerchantGrid merchants={withTest} loading={false} error={null} onSubmit={vi.fn()} />)
      // Mainnet-only data: the toggle defaults OFF, so the pill group does
      // not even render — 'media' would be its second category, and the row
      // only renders at two or more.
      expect(screen.queryByRole('group', { name: 'Filter by category' })).toBeNull()
      fireEvent.click(screen.getByLabelText('Show test merchants'))
      const group = screen.getByRole('group', { name: 'Filter by category' })
      expect(within(group).getByRole('button', { name: 'Media' })).toBeDefined()
    })
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
      expect(within(screen.getByTestId('marketplace-coming-soon')).getByText('Soon Co')).toBeDefined()
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
