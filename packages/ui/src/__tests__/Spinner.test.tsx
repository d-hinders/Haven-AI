import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Spinner } from '../Spinner'

describe('Spinner (#4563)', () => {
  it('defaults to the 16px size and gates the rotation with motion-safe', () => {
    const { container } = render(<Spinner />)
    const glyph = container.querySelector('svg')!
    expect(glyph.getAttribute('class')).toContain('h-4')
    expect(glyph.getAttribute('class')).toContain('w-4')
    // The gate is the point of the primitive: five of the six hand-rolled
    // `animate-spin` sites it replaces had no `motion-safe:` prefix.
    expect(glyph.getAttribute('class')).toContain('motion-safe:animate-spin')
    expect(glyph.getAttribute('class')).not.toMatch(/(^|\s)animate-spin/)
  })

  it('md renders the 20px size', () => {
    const { container } = render(<Spinner size="md" />)
    const glyph = container.querySelector('svg')!
    expect(glyph.getAttribute('class')).toContain('h-5')
    expect(glyph.getAttribute('class')).toContain('w-5')
  })

  it('is decorative by default — no role, no accessible name', () => {
    const { container } = render(<Spinner />)
    expect(container.firstElementChild!.getAttribute('role')).toBeNull()
    expect(container.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('a label makes it a status region with the label in an sr-only span', () => {
    render(<Spinner label="Loading payments" />)
    const status = screen.getByRole('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.textContent).toBe('Loading payments')
    // The glyph stays decorative even when the wrapper carries the name.
    expect(status.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true')
  })

  it('passes className through to the wrapper, not the glyph', () => {
    const { container } = render(<Spinner className="ml-2" />)
    expect(container.firstElementChild!.className).toContain('ml-2')
    expect(container.querySelector('svg')!.getAttribute('class')).not.toContain('ml-2')
  })
})
