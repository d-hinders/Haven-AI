import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import MarketplaceNotFound from '../not-found'

describe('marketplace not-found boundary', () => {
  it('is a designed state with a way back to the marketplace', () => {
    render(<MarketplaceNotFound />)
    expect(screen.getByText('Merchant not found')).toBeDefined()
    expect(screen.getByRole('link', { name: 'Back to Marketplace' }).getAttribute('href')).toBe('/marketplace')
  })
})
