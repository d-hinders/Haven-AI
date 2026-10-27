import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Select } from '../Select'

describe('Select', () => {
  it('draws its own chevron instead of the native arrow (#4492)', () => {
    const { container } = render(
      <Select aria-label="Period" defaultValue="week">
        <option value="week">per week</option>
      </Select>,
    )

    const select = screen.getByLabelText('Period')
    expect(select).toHaveClass('appearance-none')
    // Exactly one right-padding class: `pr-9` reserves the chevron's room, and a
    // second `pr-*` would make which one wins a stylesheet-order question.
    expect(select.className.split(/\s+/).filter((c) => c.startsWith('pr-'))).toEqual(['pr-9'])

    const icon = container.querySelector('svg')
    expect(icon).not.toBeNull()
    expect(icon).toHaveClass('pointer-events-none')
    expect(icon).toHaveClass('absolute', 'right-3', 'top-1/2', '-translate-y-1/2')
    expect(icon).toHaveAttribute('aria-hidden', 'true')
    // The enabled colour must not be the disabled one, or the disabled
    // treatment below could never fail.
    expect(icon).toHaveClass('text-[var(--v2-ink-2)]')
    expect(icon!.classList.contains('text-[var(--v2-ink-3)]')).toBe(false)
  })

  it('puts the caller className on the wrapper, not the select', () => {
    const { container } = render(
      <Select aria-label="Token" className="w-20 shrink-0">
        <option value="usdc">USDC</option>
      </Select>,
    )

    const select = screen.getByLabelText('Token')
    expect(select).not.toHaveClass('w-20')
    expect(select).not.toHaveClass('shrink-0')
    expect(select).toHaveClass('w-full')

    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.tagName).toBe('DIV')
    expect(wrapper).toHaveClass('relative', 'w-20', 'shrink-0')
  })

  it('passes disabled through to the select and dims the chevron with it', () => {
    const { container } = render(
      <Select aria-label="Token" disabled>
        <option value="usdc">USDC</option>
      </Select>,
    )

    expect(screen.getByLabelText('Token')).toBeDisabled()
    expect(container.querySelector('svg')).toHaveClass('peer-disabled:text-[var(--v2-ink-3)]')
  })
})
