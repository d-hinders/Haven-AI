import { useState } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { AttentionList } from '@/components/haven/AttentionList'
import type { AttentionListItem } from '@/components/haven/AttentionList'
import { Info, TriangleAlert } from 'lucide-react'

/**
 * The AttentionList contract (#3805).
 *
 * The list is a `<ul>` of static `Row`s whose action and dismiss live in the
 * row's trailing slot — never an `href`/`onClick` on the row itself, which
 * would nest the action inside another control. The rules under test here are
 * the ones a screenshot cannot see: the tone given in TEXT (Row's leading icon
 * is aria-hidden), the labelled dismiss, and where focus lands after a
 * dismiss — the next item, or the caller's list heading when the list emptied.
 */

const ITEMS: AttentionListItem[] = [
  {
    id: 'budget-reached',
    title: 'Travel budget reached',
    subtitle: 'It approves nothing further until you raise or clear it.',
    tone: 'neutral',
    badge: 'Budget reached',
    icon: Info,
  },
  {
    id: 'reapproval',
    title: 'Re-approval needed',
    subtitle: 'Spending paused while the agent awaits your approval.',
    tone: 'warning',
    badge: 'Needs attention',
    icon: TriangleAlert,
  },
  {
    id: 'payment-failed',
    title: 'Payment failed',
    subtitle: 'Nothing was spent.',
    tone: 'danger',
    badge: 'Failed',
  },
]

/** A caller like any other: the dismissal state lives OUTSIDE the list. */
function DismissableList({
  items: initial,
  headingId,
}: {
  items: AttentionListItem[]
  headingId?: string
}) {
  const [items, setItems] = useState(initial)
  return (
    <div>
      <h3 id={headingId} tabIndex={-1}>
        Needs attention
      </h3>
      <AttentionList
        items={items}
        onDismiss={(id) => setItems((prev) => prev.filter((item) => item.id !== id))}
        headingId={headingId}
      />
    </div>
  )
}

function renderList(items: AttentionListItem[] = ITEMS, headingId?: string) {
  return render(<DismissableList items={items} headingId={headingId} />)
}

describe('AttentionList (#3805)', () => {
  it('renders a list of static rows in the order given', () => {
    const { container } = renderList()
    const list = screen.getByRole('list')
    expect(list.tagName).toBe('UL')
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(within(rows[0]).getByText('Travel budget reached')).toBeTruthy()
    expect(within(rows[1]).getByText('Re-approval needed')).toBeTruthy()
    expect(within(rows[2]).getByText('Payment failed')).toBeTruthy()
    // The rows themselves are not controls — the action lives in trailing.
    expect(container.querySelector('a[role="button"], li > button')).toBeNull()
  })

  it('gives the tone in text, not only in colour', () => {
    renderList()
    const rows = within(screen.getByRole('list')).getAllByRole('listitem')
    // Badge labels are the tone in text...
    expect(within(rows[0]).getByText('Budget reached')).toBeTruthy()
    expect(within(rows[1]).getByText('Needs attention')).toBeTruthy()
    expect(within(rows[2]).getByText('Failed')).toBeTruthy()
  })

  it('gives a badge-less item its tone through sr-only text', () => {
    render(<AttentionList
      items={[{ id: 'tip', title: 'Weekly summary ready', tone: 'brand' }]}
      onDismiss={() => {}}
    />)
    // The tone word exists and is hidden from the eye but not the reader.
    const word = screen.getByText('Suggestion')
    expect(word.className).toContain('sr-only')
  })

  it('labels every dismiss with its item', () => {
    renderList()
    expect(
      screen.getByRole('button', { name: 'Dismiss: Travel budget reached' }),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Dismiss: Re-approval needed' }),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Dismiss: Payment failed' }),
    ).toBeTruthy()
  })

  it('dismisses by id and moves focus to the next item', async () => {
    const user = userEvent.setup()
    renderList()
    await user.click(screen.getByRole('button', { name: 'Dismiss: Travel budget reached' }))
    // The first item is gone; focus is on the dismiss of the item now FIRST.
    expect(screen.queryByRole('button', { name: 'Dismiss: Travel budget reached' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Dismiss: Re-approval needed' })).toHaveFocus()
  })

  it('moves focus to the LAST remaining item when the dismissed one was last', async () => {
    const user = userEvent.setup()
    renderList()
    await user.click(screen.getByRole('button', { name: 'Dismiss: Payment failed' }))
    expect(screen.getByRole('button', { name: 'Dismiss: Re-approval needed' })).toHaveFocus()
  })

  it('moves focus to the list heading when the list empties', async () => {
    const user = userEvent.setup()
    renderList([ITEMS[0]], 'list-heading')
    await user.click(screen.getByRole('button', { name: 'Dismiss: Travel budget reached' }))
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getByText('Needs attention')).toHaveFocus()
  })

  it('renders nothing for zero items', () => {
    const { container } = render(<AttentionList items={[]} onDismiss={() => {}} />)
    expect(container.querySelector('ul')).toBeNull()
    expect(container.textContent).toBe('')
  })

  // ── #3813: the dismiss control is per item ────────────────────────────────
  // The flag defaults to present (the #3805 contract above pins that), so
  // callers that do not say are unchanged. A `dismissible: false` row — the
  // dashboard's low-balance / budget-reached / payments-failed items —
  // renders NO dismiss control at all: its state is to be resolved, not
  // opted out of.
  it('omits the dismiss control on a dismissible: false row, keeping the rest', () => {
    render(
      <AttentionList
        items={[
          { ...ITEMS[0], dismissible: false },
          { ...ITEMS[1] },
        ]}
        onDismiss={() => {}}
      />,
    )
    expect(
      screen.queryByRole('button', { name: 'Dismiss: Travel budget reached' }),
    ).toBeNull()
    expect(screen.queryByTestId('attention-dismiss-budget-reached')).toBeNull()
    // The still-dismissible row keeps its control.
    expect(
      screen.getByRole('button', { name: 'Dismiss: Re-approval needed' }),
    ).toBeTruthy()
  })
})
