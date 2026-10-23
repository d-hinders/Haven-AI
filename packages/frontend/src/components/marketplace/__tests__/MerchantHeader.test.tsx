import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MerchantHeader, TEST_MERCHANT_NOTE } from '../MerchantHeader'
import { verifiedMeaning } from '@/lib/marketplace'
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
    lowest_price_atomic: '1000',
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
    // A wrapping paragraph, not a one-line badge (a badge clipped it at 390).
    const note = screen.getByTestId('test-merchant-note')
    expect(note.tagName).toBe('P')
    expect(note.textContent).toBe(TEST_MERCHANT_NOTE)
    unmount()
    render(<MerchantHeader merchant={merchant()} />)
    expect(screen.queryByText(/Haven test merchant/)).toBeNull()
  })

  it('renders the actions slot on the header\'s right-hand side, and nothing extra when absent', () => {
    const { unmount } = render(<MerchantHeader merchant={merchant()} actions={<button type="button">Set a budget for this merchant</button>} />)
    expect(screen.getByRole('button', { name: 'Set a budget for this merchant' })).toBeDefined()
    unmount()
    render(<MerchantHeader merchant={merchant()} />)
    expect(screen.queryByRole('button', { name: 'Set a budget for this merchant' })).toBeNull()
  })

  it('#4008: the Verified treatment is the quiet check plus the word, sentence case — asserted by element and class, not text alone', () => {
    const { unmount } = render(<MerchantHeader merchant={merchant()} />)
    // The marker: a check icon plus the word, on ONE element carrying the
    // meaning as its title. CSS `uppercase` leaves the text node unchanged,
    // so `getByText('Verified')` alone cannot prove the treatment — the
    // class list (no `uppercase`) and the sentence-case node are asserted.
    const marker = screen.getByTestId('verified-marker')
    expect(marker.querySelector('svg')).not.toBeNull()
    expect(marker.className).not.toContain('uppercase')
    expect(within(marker).getByText('Verified').textContent).toBe('Verified')
    expect(within(marker).queryByText('VERIFIED')).toBeNull()
    // The meaning is VISIBLE text on the page (a tooltip is not a home for
    // essential copy), reachable without hover, focus or tap — and it names
    // the merchant (#4003).
    expect(screen.getByTestId('verified-meaning').textContent).toBe(verifiedMeaning('Ampersend Demo API'))
    unmount()
    render(<MerchantHeader merchant={merchant({ verified_payable: false })} />)
    expect(screen.queryByTestId('verified-marker')).toBeNull()
    expect(screen.queryByTestId('verified-meaning')).toBeNull()
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
