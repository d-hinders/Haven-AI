import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MerchantGrid } from '../MerchantGrid'
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
    ...overrides,
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

  it('renders a merchant card with category, description, offer count and networks', () => {
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
    expect(screen.getByText('2 offers')).toBeDefined()
  })

  it('shows the Verified badge only when verified_payable is true', () => {
    render(
      <MerchantGrid
        merchants={[merchant({ id: 'v', slug: 'verified', verified_payable: true })]}
        loading={false}
        error={null}
        onSubmit={vi.fn()}
      />,
    )
    expect(within(screen.getByTestId('merchant-card-verified')).getByText('Verified')).toBeDefined()
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
    expect(screen.getByText('Haven test merchant — real payments, demo goods')).toBeDefined()
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
    fireEvent.click(within(categoryGroup).getByRole('button', { name: 'data' }))
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

  it('opens the submit modal callback', () => {
    const onSubmit = vi.fn()
    render(<MerchantGrid merchants={[]} loading={false} error={null} onSubmit={onSubmit} />)
    fireEvent.click(screen.getByRole('button', { name: 'List your payable service' }))
    expect(onSubmit).toHaveBeenCalled()
  })
})
