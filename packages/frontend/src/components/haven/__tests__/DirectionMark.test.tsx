/**
 * DirectionMark's contract (#4197, first test file for the component): one
 * mark per direction, colour from the semantic token pair, four densities
 * (comfortable 36px / compact 32px / figure 24px, #4259 / inline 18px), the
 * mark itself always
 * `aria-hidden` — the accessible name is the caller's sr-only text and any
 * tooltip lives on the mark through `ui/Tooltip`.
 */
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DirectionMark } from '../DirectionMark'

describe('DirectionMark', () => {
  it.each([
    ['in', 'lucide-arrow-down', 'text-[var(--v2-success)]'],
    ['out', 'lucide-arrow-up', 'text-[var(--v2-debit)]'],
    ['neutral', 'lucide-clock', 'text-[var(--v2-ink-3)]'],
    ['move', 'lucide-arrow-left-right', 'text-[var(--v2-ink-3)]'],
  ] as const)('%s renders its lucide glyph in the direction colour', (direction, glyph, colour) => {
    const { container } = render(<DirectionMark direction={direction} />)
    const mark = container.firstElementChild
    expect(mark).toHaveClass(colour)
    // The glyph is the lucide icon, drawn through the shared `Icon` — never a
    // hand-drawn copy.
    expect(mark!.querySelector(`svg.${glyph}`)).not.toBeNull()
  })

  it.each(['comfortable', 'compact', 'figure', 'inline'] as const)(
    '%s is aria-hidden — the name is the caller sr-only text, never the mark',
    (density) => {
      const { container } = render(<DirectionMark direction="in" density={density} />)
      expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
    },
  )

  it('comfortable is the default: 36px mark, 16px icon', () => {
    const { container } = render(<DirectionMark direction="in" />)
    expect(container.firstElementChild).toHaveClass('h-9 w-9', 'rounded-[10px]')
    expect(container.querySelector('svg')).toHaveClass('h-4 w-4')
  })

  it('compact: 32px mark, 14px icon — the dashboard rhythm', () => {
    const { container } = render(<DirectionMark direction="out" density="compact" />)
    expect(container.firstElementChild).toHaveClass('h-8 w-8', 'rounded-[10px]')
    expect(container.querySelector('svg')).toHaveClass('h-3.5 w-3.5')
  })

  it('figure: 24px mark, 14px icon — beside a 20px secondary figure (#4259)', () => {
    const { container } = render(<DirectionMark direction="out" density="figure" />)
    expect(container.firstElementChild).toHaveClass('h-6 w-6', 'rounded-[7px]')
    expect(container.querySelector('svg')).toHaveClass('h-3.5 w-3.5')
  })

  it('inline: 18px mark, 11px icon — a mark in dense inline text (#4197)', () => {
    const { container } = render(<DirectionMark direction="in" density="inline" />)
    expect(container.firstElementChild).toHaveClass('h-[18px] w-[18px]', 'rounded-[6px]')
    expect(container.querySelector('svg')).toHaveClass('h-[11px] w-[11px]')
  })

  // #4264: a move between your own accounts gets the two-way arrow on the
  // NEUTRAL ground — pending's clock keeps neutral for itself. A test per
  // density, since the size classes are per-density lookups.
  it('move (comfortable): lucide ArrowLeftRight on the neutral ground', () => {
    const { container } = render(<DirectionMark direction="move" />)
    expect(container.firstElementChild).toHaveClass('h-9 w-9')
    expect(container.firstElementChild).toHaveClass('border-[var(--v2-border)]')
    expect(container.firstElementChild).toHaveClass('bg-[var(--v2-surface-2)]')
    expect(container.querySelector('svg.lucide-arrow-left-right')).not.toBeNull()
    expect(container.querySelector('svg.lucide-clock')).toBeNull()
  })

  it('move (compact): lucide ArrowLeftRight on the neutral ground', () => {
    const { container } = render(<DirectionMark direction="move" density="compact" />)
    expect(container.firstElementChild).toHaveClass('h-8 w-8')
    expect(container.firstElementChild).toHaveClass('bg-[var(--v2-surface-2)]')
    expect(container.querySelector('svg.lucide-arrow-left-right')).toHaveClass('h-3.5 w-3.5')
  })

  it('move (inline): lucide ArrowLeftRight on the neutral ground', () => {
    const { container } = render(<DirectionMark direction="move" density="inline" />)
    expect(container.firstElementChild).toHaveClass('h-[18px] w-[18px]')
    expect(container.firstElementChild).toHaveClass('bg-[var(--v2-surface-2)]')
    expect(container.querySelector('svg.lucide-arrow-left-right')).toHaveClass('h-[11px] w-[11px]')
  })

  it('neutral is unchanged: still the pending clock, never the two-way arrow', () => {
    const { container } = render(<DirectionMark direction="neutral" />)
    expect(container.querySelector('svg.lucide-clock')).not.toBeNull()
    expect(container.querySelector('svg.lucide-arrow-left-right')).toBeNull()
  })
})
