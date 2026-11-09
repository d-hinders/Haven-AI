import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StepChecklist, type StepChecklistRow } from '../StepChecklist'

/**
 * #4744: the Step status checklist's connector — the one line both the
 * connect dialog's checklist and the dashboard guide draw. jsdom does no
 * layout, so geometry is the e2e specs' job; what is pinned here is which
 * segments exist and what they say.
 */

const connectors = (container: HTMLElement) =>
  [...container.querySelectorAll('ol > li')].map((li) => li.querySelector<HTMLElement>('[data-step-connector]'))

describe('StepChecklist connector (#4744)', () => {
  it('runs below every row but the last — a heading-only row included', () => {
    const rows: StepChecklistRow[] = [
      { id: 'a', state: 'done', title: 'Heading only' },
      { id: 'b', state: 'active', title: 'With a body', children: <p>Body</p> },
      { id: 'c', state: 'pending', title: 'Last' },
    ]
    const { container } = render(<StepChecklist aria-label="Steps" rows={rows} />)
    const [first, second, last] = connectors(container)
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(last).toBeNull()
    // Decorative: the headings carry the state in words.
    expect(first).toHaveAttribute('aria-hidden', 'true')
  })

  it('is 2px and static — no transition, and not the band\'s animated progress line', () => {
    const { container } = render(
      <StepChecklist
        aria-label="Steps"
        rows={[
          { id: 'a', state: 'done', title: 'A' },
          { id: 'b', state: 'pending', title: 'B' },
        ]}
      />,
    )
    const [segment] = connectors(container)
    expect(segment).toHaveClass('w-0.5')
    expect(segment!.className).not.toMatch(/transition|duration-|animate-|v2-progress-line/)
  })

  it('takes the success tint only below a done marker, whatever the steps around it', () => {
    // Out of order: done, pending, done, working, pending.
    const { container } = render(
      <StepChecklist
        aria-label="Steps"
        rows={[
          { id: 'a', state: 'done', title: 'A' },
          { id: 'b', state: 'pending', title: 'B' },
          { id: 'c', state: 'done', title: 'C' },
          { id: 'd', state: 'working', title: 'D' },
          { id: 'e', state: 'active', title: 'E' },
          { id: 'f', state: 'pending', title: 'F' },
        ]}
      />,
    )
    const segments = connectors(container).slice(0, -1)
    expect(segments.map((s) => s!.getAttribute('data-step-connector'))).toEqual(['done', 'open', 'done', 'open', 'open'])
    for (const segment of segments) {
      const done = segment!.getAttribute('data-step-connector') === 'done'
      expect(segment!.className.includes('var(--v2-success)')).toBe(done)
      // #4747: the open segment is the pending ring's own colour, never heavier.
      expect(segment!.className.includes('bg-[var(--v2-border)]')).toBe(!done)
      expect(segment!.className).not.toContain('border-strong')
    }
  })
})

describe('StepChecklist rows (#4744)', () => {
  it('numerals only when numbered, and never on a done or working marker', () => {
    const rows: StepChecklistRow[] = [
      { id: 'a', state: 'done', title: 'A', number: 1 },
      { id: 'b', state: 'working', title: 'B', number: 2 },
      { id: 'c', state: 'active', title: 'C', number: 3 },
      { id: 'd', state: 'pending', title: 'D', number: 4 },
    ]
    const markers = (container: HTMLElement) =>
      [...container.querySelectorAll('ol > li')].map((li) => li.querySelector('[aria-hidden="true"]')!.textContent)
    const { container, rerender } = render(<StepChecklist aria-label="Steps" rows={rows} />)
    expect(markers(container)).toEqual(['', '', '', ''])
    rerender(<StepChecklist aria-label="Steps" rows={rows} numbered />)
    expect(markers(container)).toEqual(['', '', '3', '4'])
  })

  it('passes the consumer\'s row attributes and heading element through', () => {
    const { container } = render(
      <StepChecklist
        aria-labelledby="label"
        headingAs="p"
        rows={[{ id: 'a', state: 'pending', title: 'A', rowAttributes: { 'data-status': 'locked' } }]}
      />,
    )
    const li = container.querySelector('li')!
    expect(li).toHaveAttribute('data-status', 'locked')
    expect(li).toHaveAttribute('data-step-state', 'pending')
    expect(container.querySelector('ol')).toHaveAttribute('aria-labelledby', 'label')
    expect(container.querySelector('h3')).toBeNull()
    expect(li.querySelector('p')!.textContent).toBe('Not started: A')
  })

  it('an actionable pending row reads at full ink; a plain pending row at ink-2', () => {
    const { getByText } = render(
      <StepChecklist
        aria-label="Steps"
        rows={[
          { id: 'a', state: 'pending', title: 'Open now', actionable: true, description: 'Body' },
          { id: 'b', state: 'pending', title: 'Not yet', description: 'Later' },
        ]}
      />,
    )
    expect(getByText('Open now').closest('h3')).toHaveClass('text-[var(--v2-ink)]')
    expect(getByText('Body')).toHaveClass('text-[var(--v2-ink-2)]')
    expect(getByText('Not yet').closest('h3')).toHaveClass('text-[var(--v2-ink-2)]')
    expect(getByText('Later')).toHaveClass('text-[var(--v2-ink-3)]')
  })
})
