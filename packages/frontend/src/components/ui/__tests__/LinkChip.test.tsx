import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LinkChip } from '@/components/ui/LinkChip'

/**
 * The account-link pill (#4472). Three properties the Settings row depends on
 * and a screenshot cannot see: it navigates to the href it was given, its
 * accessible name is exactly its visible text (the trailing arrow is
 * decorative), and it carries the one focus-ring treatment from
 * design-system.md § *Focus rings*.
 */
describe('LinkChip (#4472)', () => {
  it('renders an outline pill link to the href it was given', () => {
    render(<LinkChip href="/accounts/a1?tab=security">Reserve (4024)</LinkChip>)
    const link = screen.getByRole('link', { name: 'Reserve (4024)' })
    expect(link).toHaveAttribute('href', '/accounts/a1?tab=security')
    expect(link.className).toContain('rounded-full')
    expect(link.className).toContain('border')
  })

  it('names the link by its children alone — the arrow is decorative', () => {
    render(<LinkChip href="/accounts/a1?tab=security">My account</LinkChip>)
    const link = screen.getByRole('link', { name: 'My account' })
    // The lucide glyph renders through `Icon`, which is `aria-hidden` by
    // default, so it contributes nothing to the accessible name.
    const svg = link.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg).toHaveAttribute('aria-hidden', 'true')
  })

  it('carries the one focus-ring treatment', () => {
    render(<LinkChip href="/accounts/a1?tab=security">My account</LinkChip>)
    const link = screen.getByRole('link', { name: 'My account' })
    expect(link.className).toContain('focus-visible:outline-none')
    expect(link.className).toContain('focus-visible:ring-2')
    expect(link.className).toContain('focus-visible:ring-brand/80')
  })
})
