import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Milestone } from '@/components/ui/Milestone'

/**
 * #4702: the one pattern for a moment worth noticing, at three strengths.
 *
 * The global stub in `__tests__/setup.ts` answers `prefers-reduced-motion:
 * reduce`, so every case here overrides `matchMedia` explicitly: the point of
 * the component is that it does not opt in to the animation class at all under
 * `reduce`, and that is only visible if both answers are exercised.
 */
function setReducedMotion(reduce: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: reduce && query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

const MARK = <span data-testid="mark">✓</span>

afterEach(() => {
  // Restore the suite-wide stub so a later file is not left on no-preference.
  setReducedMotion(true)
})

describe('Milestone (#4702)', () => {
  describe('under prefers-reduced-motion: reduce', () => {
    it('peak does not opt in to check-pop or the bloom', () => {
      setReducedMotion(true)
      const { container } = render(
        <Milestone strength="peak">
          {MARK}
        </Milestone>,
      )
      expect(container.querySelector('.animate-check-pop')).toBeNull()
      expect(container.querySelector('.v2-animate-bloom')).toBeNull()
      expect(screen.getByTestId('mark')).toBeTruthy()
    })

    it('step does not opt in to check-pop', () => {
      setReducedMotion(true)
      const { container } = render(
        <Milestone strength="step">
          {MARK}
        </Milestone>,
      )
      expect(container.querySelector('.animate-check-pop')).toBeNull()
      expect(screen.getByTestId('mark')).toBeTruthy()
    })

    it('live does not opt in to the row fade', () => {
      setReducedMotion(true)
      const { container } = render(
        <Milestone strength="live">
          {MARK}
        </Milestone>,
      )
      expect(container.querySelector('.v2-animate-live')).toBeNull()
      expect(screen.getByTestId('mark')).toBeTruthy()
    })
  })

  describe('under prefers-reduced-motion: no-preference', () => {
    it('peak plays check-pop and the bloom', () => {
      setReducedMotion(false)
      const { container } = render(
        <Milestone strength="peak">
          {MARK}
        </Milestone>,
      )
      expect(container.querySelector('.animate-check-pop')).toBeTruthy()
      expect(container.querySelector('.v2-animate-bloom')).toBeTruthy()
    })

    it('step plays check-pop only — no bloom', () => {
      setReducedMotion(false)
      const { container } = render(
        <Milestone strength="step">
          {MARK}
        </Milestone>,
      )
      expect(container.querySelector('.animate-check-pop')).toBeTruthy()
      expect(container.querySelector('.v2-animate-bloom')).toBeNull()
    })

    it('live plays the row fade and no check', () => {
      setReducedMotion(false)
      const { container } = render(
        <Milestone strength="live">
          {MARK}
        </Milestone>,
      )
      expect(container.querySelector('.v2-animate-live')).toBeTruthy()
      expect(container.querySelector('.animate-check-pop')).toBeNull()
    })

    it('play={false} renders the child static', () => {
      setReducedMotion(false)
      const { container } = render(
        <Milestone strength="peak" play={false}>
          {MARK}
        </Milestone>,
      )
      expect(container.querySelector('.animate-check-pop')).toBeNull()
      expect(container.querySelector('.v2-animate-bloom')).toBeNull()
      expect(screen.getByTestId('mark')).toBeTruthy()
    })
  })

  it('the bloom scales to the child instead of carrying a fixed size', () => {
    setReducedMotion(false)
    const { container } = render(
      <Milestone strength="peak">
        <span className="flex h-14 w-14" />
      </Milestone>,
    )
    const bloom = container.querySelector('.v2-animate-bloom')
    expect(bloom).toBeTruthy()
    expect(bloom?.className).toContain('absolute')
    expect(bloom?.className).toContain('inset-0')
    expect(bloom?.className).not.toMatch(/\bh-24\b|\bw-24\b/)
  })

  it('the bloom is the success colour, never brand (owner review on #4728)', () => {
    setReducedMotion(false)
    const { container } = render(
      <Milestone strength="peak">
        {MARK}
      </Milestone>,
    )
    const bloom = container.querySelector('.v2-animate-bloom') as HTMLElement | null
    expect(bloom).toBeTruthy()
    const background = bloom?.getAttribute('style') ?? ''
    expect(background).toContain('var(--v2-success-rgb)')
    expect(background).not.toContain('--v2-brand-rgb')
  })

  it('owns no live region — the announcement stays with the caller', () => {
    setReducedMotion(false)
    render(
      <Milestone strength="peak">
        {MARK}
      </Milestone>,
    )
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
