import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Row } from '../Row'

describe('Row density', () => {
  it('comfortable and compact carry the primitive padding', () => {
    const a = render(<Row title="Agent" />).container.firstElementChild as HTMLElement
    expect(a.className).toMatch(/\bpx-4\b/)
    const b = render(<Row title="Agent" density="compact" />).container.firstElementChild as HTMLElement
    expect(b.className).toMatch(/\bpx-3\b/)
  })

  it('flush removes the primitive padding so a caller-padded box owns the inset (#3204)', () => {
    // A `className="px-0"` cannot do this: the primitive's `px-4` is emitted
    // later in the stylesheet and wins, which is how the analytics row lists
    // came to be double-inset on a phone. Mutation: map `flush` to `px-4 py-3`
    // → red.
    const root = render(<Row title="Agent" density="flush" />).container.firstElementChild as HTMLElement
    expect(root.className).toMatch(/\bp-0\b/)
    expect(root.className).not.toMatch(/\bpx-4\b|\bpy-3\b/)
  })
})

describe('Row — titleClassName / trailingClassName (#3805)', () => {
  it('lands the title override on the title paragraph, not the row root', () => {
    // AttentionList clamps the title to two lines below `sm`; classes aimed at
    // the row root would land on the flex container and do nothing.
    const { container } = render(<Row title="Agent" titleClassName="line-clamp-2" />)
    const title = container.querySelector('p')!
    expect(title.className).toContain('line-clamp-2')
    expect(title.className).toContain('truncate')
    expect((container.firstElementChild as HTMLElement).className).not.toContain('line-clamp-2')
  })

  it('lands the trailing override on the trailing wrapper', () => {
    const { container } = render(
      <Row title="Agent" trailing={<span>x</span>} trailingClassName="basis-full" />,
    )
    expect(container.querySelector('.basis-full')).not.toBeNull()
  })

  it('renders byte-identical classes when neither override is given', () => {
    const { container } = render(<Row title="Agent" trailing={<span>x</span>} />)
    expect(container.querySelector('p')!.className).toBe('truncate text-sm font-medium text-[var(--v2-ink)]')
    expect(container.innerHTML).not.toContain('undefined')
  })
})
