import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Address, truncateAddress } from '@/components/haven/Address'

const ADDR = '0x8f4F0f6d712C5c5C9Bb02F4a5B5c0D7F462A6f4C'

describe('Address (#853)', () => {
  it('truncates with the canonical 6…4 rule', () => {
    expect(truncateAddress(ADDR)).toBe('0x8f4F…6f4C')
    render(<Address value={ADDR} />)
    expect(screen.getByText('0x8f4F…6f4C')).toBeTruthy()
  })

  it('renders monospace', () => {
    render(<Address value={ADDR} />)
    expect(screen.getByText('0x8f4F…6f4C').className).toContain('font-mono')
  })

  it('truncate={false} renders the full value with no tooltip', () => {
    const { container } = render(<Address value={ADDR} truncate={false} />)
    expect(screen.getByText(ADDR)).toBeTruthy()
    // No tooltip trigger around a full address:
    expect(container.textContent).toBe(ADDR)
  })

  it('href renders an external explorer link with the ↗ affordance', () => {
    render(<Address value={ADDR} href="https://basescan.org/address/x" />)
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe('https://basescan.org/address/x')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(link.textContent).toContain('0x8f4F…6f4C')
    expect(link.textContent).toContain('↗')
  })

  describe('copy', () => {
    beforeEach(() => {
      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    })

    it('copies the FULL address and pops the check', async () => {
      render(<Address value={ADDR} copy />)
      const button = screen.getByRole('button', { name: 'Copy address' })
      fireEvent.click(button)
      await waitFor(() =>
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(ADDR),
      )
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Address copied' })).toBeTruthy(),
      )
    })

    it('renders no copy button by default', () => {
      render(<Address value={ADDR} />)
      expect(screen.queryByRole('button')).toBeNull()
    })
  })
})
