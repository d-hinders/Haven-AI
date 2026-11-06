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

  it('grouped shows the whole value in fours, with spacing rather than spaces', () => {
    const value = '0x18a43F6c7D5c84C3a715097C57B9945ce10C5162'
    const { container } = render(<Address value={value} grouped />)
    const lines = Array.from(container.querySelectorAll('.whitespace-nowrap')).map((line) =>
      Array.from(line.children).map((group) => group.textContent),
    )
    expect(lines).toEqual([
      ['0x18a4', '3F6c', '7D5c', '84C3', 'a715'],
      ['097C', '57B9', '945c', 'e10C', '5162'],
    ])
    // The DOM text is the unbroken address, which is what a copy delivers.
    expect(container.textContent).toBe(value)
    expect(container.firstElementChild).toHaveClass('w-min')
    expect(container.innerHTML).not.toContain('flex')
    expect(container.innerHTML).not.toContain('grid')
  })

  it('grouped keeps five to a line for a longer value', () => {
    const hash = '0x' + 'ab'.repeat(32)
    const { container } = render(<Address value={hash} grouped />)
    const lines = Array.from(container.querySelectorAll('.whitespace-nowrap'))
    expect(lines.map((line) => line.children.length)).toEqual([5, 5, 5, 1])
    expect(container.textContent).toBe(hash)
  })
})
