import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Monogram } from '../Monogram'

// Captured from `origin/dev` @ e44a7a79a's Monogram, before #4210 added `xs`
// and `decorative`: the default output is pinned whole, so a change to an
// existing caller's markup goes red here rather than in a baseline.
const BEFORE = {
  sm: '<div class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-[var(--v2-border)] bg-[var(--v2-avatar-4-soft)]"><span class="text-xs font-semibold text-[var(--v2-avatar-4)]">HS</span></div>',
  md: '<div class="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full border border-[var(--v2-border)] bg-[var(--v2-avatar-4-soft)]"><span class="text-sm font-semibold text-[var(--v2-avatar-4)]">HS</span></div>',
  smLogo: '<img alt="" class="h-9 w-9 flex-shrink-0 rounded-full border border-[var(--v2-border)] object-cover" src="https://e.x/l.png">',
  mdLogo: '<img alt="" class="h-12 w-12 flex-shrink-0 rounded-full border border-[var(--v2-border)] object-cover" src="https://e.x/l.png">',
}

describe('Monogram (#4210)', () => {
  it('renders sm and md exactly as before when neither xs nor decorative is used', () => {
    expect(render(<Monogram name="Haven Demo Store" />).container.innerHTML).toBe(BEFORE.sm)
    expect(render(<Monogram name="Haven Demo Store" size="md" />).container.innerHTML).toBe(BEFORE.md)
    expect(render(<Monogram name="X" logoUrl="https://e.x/l.png" />).container.innerHTML).toBe(BEFORE.smLogo)
    expect(render(<Monogram name="X" logoUrl="https://e.x/l.png" size="md" />).container.innerHTML).toBe(
      BEFORE.mdLogo,
    )
  })

  it('xs is a 32px box with text-xs initials', () => {
    const root = render(<Monogram name="Haven Demo Store" size="xs" />).container.firstElementChild!
    expect(root.className.split(' ')).toEqual(expect.arrayContaining(['h-8', 'w-8']))
    expect(root.className).not.toMatch(/\bh-9\b|\bh-12\b/)
    expect(root.querySelector('span')!.className.split(' ')).toContain('text-xs')
    const logo = render(<Monogram name="X" logoUrl="https://e.x/l.png" size="xs" />).container.firstElementChild!
    expect(logo.className.split(' ')).toEqual(expect.arrayContaining(['h-8', 'w-8']))
  })

  it('decorative hides the initials and the logo from assistive tech, at the root', () => {
    const initials = render(<Monogram name="Haven Demo Store" size="xs" decorative />).container
    expect(initials.firstElementChild!.getAttribute('aria-hidden')).toBe('true')
    const logo = render(<Monogram name="X" logoUrl="https://e.x/l.png" decorative />).container
    expect(logo.firstElementChild!.getAttribute('aria-hidden')).toBe('true')
  })

  it('without decorative the initials stay readable — no aria-hidden anywhere', () => {
    const { container } = render(<Monogram name="Haven Demo Store" size="xs" />)
    expect(container.querySelector('[aria-hidden]')).toBeNull()
    expect(container.textContent).toBe('HS')
  })
})
