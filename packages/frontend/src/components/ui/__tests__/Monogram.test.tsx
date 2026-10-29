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

/**
 * The stored tint (#4428): an agent passes its own tint and the mark wears it;
 * a merchant or a contact passes nothing and keeps the name hash. The two
 * names below hash to the SAME tint (6 under djb2 mod 6), so the pair is the
 * rule the epic changed — before it, they were indistinguishable circles.
 */
describe('Monogram tint (#4428)', () => {
  const classesOf = (name: string, tint?: number) => {
    const root = render(<Monogram name={name} tint={tint} />).container.firstElementChild!
    const ink = root.querySelector('span')!
    return { bg: root.className, ink: ink.className }
  }

  it('renders the given tint over the name hash', () => {
    // 'Research agent' hashes to tint 6; the stored tint 2 wins.
    const stored = classesOf('Research agent', 2)
    expect(stored.bg).toContain('bg-[var(--v2-avatar-2-soft)]')
    expect(stored.ink).toContain('text-[var(--v2-avatar-2)]')
    expect(stored.bg).not.toContain('avatar-6')
  })

  it('renders the name hash when no tint is given — merchants and contacts', () => {
    const hashed = classesOf('Research agent')
    expect(hashed.bg).toContain('bg-[var(--v2-avatar-6-soft)]')
    expect(hashed.ink).toContain('text-[var(--v2-avatar-6)]')
  })

  it('draws two hash-alike agents in different colours when each carries its own tint', () => {
    const research = classesOf('Research agent', 6)
    const dataFeed = classesOf('Data-feed agent', 2)
    expect(research.bg).not.toBe(dataFeed.bg)
    expect(research.ink).not.toBe(dataFeed.ink)
  })

  it('falls back to the hash for a tint outside 1..6 rather than rendering no class', () => {
    for (const bad of [0, 7, 2.5]) {
      const classes = classesOf('Research agent', bad)
      expect(classes.bg).toContain('bg-[var(--v2-avatar-6-soft)]')
    }
  })

  it('leaves a logo untinted — the tint is the initials variant only', () => {
    const { container } = render(<Monogram name="Research agent" tint={2} logoUrl="https://e.x/l.png" />)
    expect(container.innerHTML).toBe(BEFORE.smLogo)
  })
})
