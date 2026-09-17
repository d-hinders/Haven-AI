import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { MerchantHeader } from '../MerchantHeader'
import type { Merchant } from '@/hooks/useCatalog'

function merchant(overrides: Partial<Merchant> = {}): Merchant {
  return {
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
    offer_count: 3,
    networks: ['eip155:8453', 'eip155:84532'],
    verified_payable: true,
    ...overrides,
  }
}

describe('MerchantHeader', () => {
  it('is the page heading: one h1 with the name, the category, the description and named networks', () => {
    render(<MerchantHeader merchant={merchant()} />)
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1, name: 'Ampersend Demo API' })).toBeDefined()
    expect(screen.getByText('API')).toBeDefined()
    expect(screen.getByText('Fact, joke and quote endpoints.')).toBeDefined()
    expect(screen.getByText('Base')).toBeDefined()
    expect(screen.getByText('Base Sepolia')).toBeDefined()
    expect(screen.queryByText(/eip155:/)).toBeNull()
  })

  it('labels a test merchant on the page itself, where the payment is one paste away', () => {
    const { unmount } = render(<MerchantHeader merchant={merchant({ is_test_merchant: true })} />)
    expect(screen.getByText('Haven test merchant — real payments, demo goods')).toBeDefined()
    unmount()
    render(<MerchantHeader merchant={merchant()} />)
    expect(screen.queryByText(/Haven test merchant/)).toBeNull()
  })

  it('shows the Verified badge with the honest claim only when verified payable', async () => {
    const { unmount } = render(<MerchantHeader merchant={merchant()} />)
    expect(screen.getByText('Verified')).toBeDefined()
    // The meaning is a reachable tooltip (keyboard focus opens it), not a
    // native title, which is mouse-only.
    expect(screen.queryByTitle('Domain controlled and verified payable')).toBeNull()
    await userEvent.setup({ delay: null }).tab()
    expect(screen.getByRole('tooltip').textContent).toContain('domain controlled and verified payable')
    unmount()
    render(<MerchantHeader merchant={merchant({ verified_payable: false })} />)
    expect(screen.queryByText('Verified')).toBeNull()
  })

  it('links the website in a new tab without the scheme, and omits the link when there is none', () => {
    const { unmount } = render(<MerchantHeader merchant={merchant()} />)
    const link = screen.getByRole('link', { name: 'app.ampersend.ai' })
    expect(link.getAttribute('href')).toBe('https://app.ampersend.ai')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    unmount()
    render(<MerchantHeader merchant={merchant({ website: null })} />)
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('falls back to a monogram when there is no logo, and to the logo when there is', () => {
    const { unmount } = render(<MerchantHeader merchant={merchant()} />)
    expect(screen.getByText('AA')).toBeDefined()
    unmount()
    render(<MerchantHeader merchant={merchant({ logo_url: 'https://cdn.example/logo.png' })} />)
    expect(screen.queryByText('AA')).toBeNull()
    expect(document.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/logo.png')
  })
})
