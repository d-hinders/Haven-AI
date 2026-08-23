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

  it('href renders an external explorer link whose affordance is the lucide ExternalLink, not a raw glyph (#1857)', () => {
    render(<Address value={ADDR} href="https://basescan.org/address/x" />)
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe('https://basescan.org/address/x')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(link.textContent).toContain('0x8f4F…6f4C')

    // The affordance is the same lucide glyph `TransactionActivityRow` and
    // `SendModal` already render for it. Pinned by exact class TOKEN through
    // `classList` — deliberately NOT a regex or `\b` match over the class
    // string, because the sizing class `h-3.5` carries a dot and
    // word-boundary assertions over Tailwind arbitrary/decimal values have
    // failed in this repo in both directions (matching nothing, and matching
    // the wrong thing).
    const icon = link.querySelector('svg')
    expect(icon).not.toBeNull()
    expect(icon!.classList.contains('lucide-external-link')).toBe(true)
    expect(icon!.getAttribute('stroke-width')).toBe('1.5')
    // Decorative: the arrow carried no meaning as text and must carry none now.
    expect(icon!.getAttribute('aria-hidden')).toBe('true')

    // Paired negative — the raw `↗` (#1857) is GONE, not merely joined by an
    // icon. Without this, adding the icon while leaving the glyph in place
    // would pass every assertion above.
    expect(link.textContent).not.toContain('↗')
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
