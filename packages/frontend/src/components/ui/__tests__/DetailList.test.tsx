import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DetailList } from '../DetailList'

describe('DetailList', () => {
  it('renders a hairline-divided dl with one dt/dd pair per row (#4475)', () => {
    const { container } = render(
      <DetailList
        items={[
          { label: 'Account', value: 'Operating account' },
          { label: 'Added', value: '2 Sept 2026' },
        ]}
      />,
    )
    const dl = container.firstElementChild as HTMLElement
    expect(dl.tagName).toBe('DL')
    expect(dl.className).toMatch(/\bdivide-y\b/)
    expect(dl.className).toMatch(/divide-\[var\(--v2-border\)\]/)
    expect(dl.querySelectorAll('dt')).toHaveLength(2)
    expect(dl.querySelectorAll('dd')).toHaveLength(2)
    expect(dl.querySelector('dt')?.textContent).toBe('Account')
    expect(dl.querySelector('dd')?.textContent).toBe('Operating account')
  })

  it('stacks the label over the value below sm — the 160px track only from sm up', () => {
    // The extraction's contract: `grid gap-1` (one column) with the label
    // track arriving at `sm`. Mutation: drop the grid → red.
    const { container } = render(<DetailList items={[{ label: 'Account', value: 'Operating account' }]} />)
    const row = container.querySelector('dl > div') as HTMLElement
    expect(row.className).toMatch(/\bgrid\b/)
    expect(row.className).toMatch(/\bgap-1\b/)
    expect(row.className).toMatch(/sm:grid-cols-\[160px_1fr\]/)
    expect(row.className).toMatch(/\bpy-3\b/)
    expect(row.className).toMatch(/\bfirst:pt-0\b/)
    expect(row.className).toMatch(/\blast:pb-0\b/)
  })

  it('narrows the label track and the row padding when compact', () => {
    const { container } = render(
      <DetailList density="compact" items={[{ label: 'Budget', value: '250 USDC per day' }]} />,
    )
    const row = container.querySelector('dl > div') as HTMLElement
    expect(row.className).toMatch(/sm:grid-cols-\[120px_1fr\]/)
    expect(row.className).toMatch(/\bpy-2\b/)
  })

  it('renders the helper under the value in the ink-3 helper tier (#1431)', () => {
    const { container } = render(
      <DetailList
        items={[{ label: 'Account', value: 'Operating account', helper: 'The Haven account this passkey approves.' }]}
      />,
    )
    const helper = container.querySelector('dd p') as HTMLElement
    expect(helper.textContent).toBe('The Haven account this passkey approves.')
    expect(helper.className).toMatch(/\btext-xs\b/)
    expect(helper.className).toMatch(/text-\[var\(--v2-ink-3\)\]/)
    expect(helper.className).toMatch(/\bmt-1\b/)
  })

  it('adds a trailing-actions column only on the rows that carry actions (#4475)', () => {
    // Mutation: always render the third track → red: a row with no actions
    // would reserve an empty column and its value would stop filling the row.
    const { container, getAllByText } = render(
      <DetailList
        items={[
          { label: 'Account', value: 'Operating account', actions: <button type="button">Remove</button> },
          { label: 'Last used', value: 'Yesterday, 14:02' },
        ]}
      />,
    )
    const rows = Array.from(container.querySelectorAll('dl > div')) as HTMLElement[]
    expect(rows[0].className).toMatch(/sm:grid-cols-\[160px_1fr_auto\]/)
    expect(rows[1].className).toMatch(/sm:grid-cols-\[160px_1fr\]/)
    expect(rows[1].className).not.toMatch(/_auto\]/)
    // The action sits in its own cell, after the value.
    const actionCell = rows[0].lastElementChild as HTMLElement
    expect(actionCell.textContent).toBe('Remove')
    expect(actionCell.className).toMatch(/\bsm:justify-end\b/)
    expect(getAllByText('Remove')).toHaveLength(1)
    // The row without actions has exactly two cells.
    expect(rows[1].children).toHaveLength(2)
  })

  it('keeps ONE grid-template class per row — the compact track survives an actions row', () => {
    // Two `sm:grid-cols-[…]` utilities on one element resolve by their order in
    // the compiled stylesheet, not in the class string, so the compact 120px
    // track would silently lose to the actions track. Mutation: emit both → red.
    const { container } = render(
      <DetailList
        density="compact"
        items={[{ label: 'Account', value: 'Operating account', actions: <button type="button">Remove</button> }]}
      />,
    )
    const row = container.querySelector('dl > div') as HTMLElement
    const tracks = row.className.match(/sm:grid-cols-\[[^\]]+\]/g) ?? []
    expect(tracks).toEqual(['sm:grid-cols-[120px_1fr_auto]'])
  })

  it('owns no outer margin — the caller spaces it', () => {
    const { container } = render(
      <DetailList className="mt-5" items={[{ label: 'Account', value: 'Operating account' }]} />,
    )
    const dl = container.firstElementChild as HTMLElement
    expect(dl.className).toMatch(/\bmt-5\b/)
    expect(dl.className).not.toMatch(/\bmt-3\b/)
  })
})
