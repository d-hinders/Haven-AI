import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AgentRulesSummary } from '../AgentRulesSummary'
import { DetailList } from '@/components/ui/DetailList'

const ITEMS = [
  { label: 'Agent name', value: 'Research assistant', helper: 'This agent can request payments using its Haven credential.' },
  { label: 'Spend from', value: 'Operating wallet' },
  { label: 'Budget', value: '250 USDC per day' },
]

describe('AgentRulesSummary renders through the shared DetailList (#4475)', () => {
  it('emits exactly the DetailList markup for its rows — the extraction is a move, not a redesign', () => {
    // The strongest form of "rendered output unchanged": the card's `dl` is
    // byte-identical to the shared list's own output for the same items and
    // the same outer margin. Mutation: hand-roll the rows again (or drift a
    // class) → red.
    const { container: card } = render(<AgentRulesSummary items={ITEMS} />)
    const { container: list } = render(<DetailList items={ITEMS} className="mt-5" />)
    expect(card.querySelector('dl')?.outerHTML).toBe(list.querySelector('dl')?.outerHTML)
  })

  it('keeps the pre-extraction classes on the list and its rows', () => {
    // Pinned literally, because these are the classes the connect flow's
    // approval step and the agent-rules specimen rendered before #4475.
    const { container } = render(<AgentRulesSummary items={ITEMS} />)
    const dl = container.querySelector('dl') as HTMLElement
    expect(dl.className).toBe('mt-5 divide-y divide-[var(--v2-border)]')
    const row = dl.querySelector('div') as HTMLElement
    expect(row.className).toBe('py-3 sm:grid-cols-[160px_1fr] grid gap-1 first:pt-0 last:pb-0 sm:gap-4')
    const dt = row.querySelector('dt') as HTMLElement
    expect(dt.className).toBe('text-xs font-medium text-[var(--v2-ink-3)]')
    const value = row.querySelector('dd > div') as HTMLElement
    expect(value.className).toBe('text-sm font-medium text-[var(--v2-ink)]')
    const helper = row.querySelector('dd p') as HTMLElement
    expect(helper.className).toBe('mt-1 text-xs leading-relaxed text-[var(--v2-ink-3)]')
  })

  it('keeps the compact density’s 120px label track and tighter rows', () => {
    const { container } = render(<AgentRulesSummary items={ITEMS} density="compact" />)
    const dl = container.querySelector('dl') as HTMLElement
    expect(dl.className).toBe('mt-3 divide-y divide-[var(--v2-border)]')
    const row = dl.querySelector('div') as HTMLElement
    expect(row.className).toBe('py-2 sm:grid-cols-[120px_1fr] grid gap-1 first:pt-0 last:pb-0 sm:gap-4')
    expect((row.querySelector('dd p') as HTMLElement).className).toBe(
      'mt-0.5 text-xs leading-relaxed text-[var(--v2-ink-3)]',
    )
  })

  it('keeps the title, the description and the footer where they were', () => {
    const { container, getByText } = render(
      <AgentRulesSummary items={ITEMS} footer={<button type="button">Pause agent</button>} />,
    )
    expect(container.querySelector('h3')?.textContent).toBe('Agent rules')
    expect(getByText('These rules define what the agent can do automatically.')).toBeTruthy()
    expect(getByText('Pause agent')).toBeTruthy()
  })

  it('omits the card heading when title is null (#1684)', () => {
    const { container } = render(<AgentRulesSummary title={null} items={ITEMS} />)
    expect(container.querySelector('h3')).toBeNull()
  })
})
