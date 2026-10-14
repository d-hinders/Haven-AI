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
 * dismiss — the next dismissible item, or the caller's list heading when no
 * dismiss button remains.
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

  // One trailing column: a mixed list (the dashboard's "Needs setup" with its
  // X above "Low balance" without one) staggered its actions by the X's
  // width. The non-dismissible row now keeps an empty, aria-hidden slot in
  // the X's place — and a list with no dismissible row reserves nothing.
  it('reserves the dismiss slot on a non-dismissible row when another row has the X', () => {
    const { container } = render(
      <AttentionList
        items={[
          { ...ITEMS[0], dismissible: false },
          { ...ITEMS[1] },
        ]}
        onDismiss={() => {}}
      />,
    )
    const rows = container.querySelectorAll('li')
    const slot = rows[0].querySelector('[data-attention-dismiss-slot]')
    expect(slot).not.toBeNull()
    expect(slot?.getAttribute('aria-hidden')).toBe('true')
    // The dismissible row has the real control, not a slot.
    expect(rows[1].querySelector('[data-attention-dismiss-slot]')).toBeNull()
    expect(rows[1].querySelector('[data-attention-dismiss]')).not.toBeNull()
  })

  it('reserves no dismiss slot when no row is dismissible', () => {
    const { container } = render(
      <AttentionList
        items={ITEMS.map((item) => ({ ...item, dismissible: false }))}
        onDismiss={() => {}}
      />,
    )
    expect(container.querySelector('[data-attention-dismiss-slot]')).toBeNull()
  })

  it('gives every action the shared minimum width', () => {
    render(
      <AttentionList
        items={[{ ...ITEMS[0], action: <button type="button">Review</button> }]}
        onDismiss={() => {}}
      />,
    )
    const wrapper = screen.getByRole('button', { name: 'Review' }).parentElement
    expect(wrapper?.className).toContain('min-w-[7rem]')
  })

  // A row with nothing visible on the right (no badge, no action) has
  // nothing to align — and below sm its slot would wrap into an empty 32px
  // line under the body — so it reserves nothing even in a mixed list.
  it('reserves no slot on a row with no badge and no action', () => {
    const { container } = render(
      <AttentionList
        items={[
          { ...ITEMS[0], id: 'bare', badge: undefined, action: undefined, dismissible: false },
          { ...ITEMS[1] },
        ]}
        onDismiss={() => {}}
      />,
    )
    expect(container.querySelector('[data-attention-dismiss-slot]')).toBeNull()
  })

  // Focus after a dismiss is counted among the dismiss BUTTONS, not among the
  // rows: with non-dismissible rows above, an index into `items` overshoots
  // and skips the next dismissible row.
  it('moves focus to the next DISMISSIBLE row when non-dismissible rows precede it', async () => {
    const user = userEvent.setup()
    const fixed = (id: string): AttentionListItem => ({
      id,
      title: `Fixed ${id}`,
      tone: 'neutral',
      dismissible: false,
    })
    const open = (id: string): AttentionListItem => ({
      id,
      title: `Open ${id}`,
      tone: 'brand',
    })
    renderList([fixed('n1'), fixed('n2'), fixed('n3'), open('a'), open('b'), open('c')])
    await user.click(screen.getByRole('button', { name: 'Dismiss: Open a' }))
    expect(screen.queryByRole('button', { name: 'Dismiss: Open a' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Dismiss: Open b' })).toHaveFocus()
  })

  it('counts interleaved non-dismissible rows out: [N, A, N, B] dismiss A → B', async () => {
    const user = userEvent.setup()
    renderList([
      { ...ITEMS[0], dismissible: false },
      ITEMS[1],
      { ...ITEMS[2], dismissible: false },
      { id: 'b', title: 'Open b', tone: 'brand' },
    ])
    await user.click(screen.getByRole('button', { name: 'Dismiss: Re-approval needed' }))
    expect(screen.getByRole('button', { name: 'Dismiss: Open b' })).toHaveFocus()
  })

  it('clamps to the last remaining dismissible row: [A, N, B, N] dismiss B → A', async () => {
    const user = userEvent.setup()
    renderList([
      ITEMS[0],
      { ...ITEMS[1], dismissible: false },
      ITEMS[2],
      { id: 'n', title: 'Fixed n', tone: 'neutral', dismissible: false },
    ])
    await user.click(screen.getByRole('button', { name: 'Dismiss: Payment failed' }))
    expect(screen.getByRole('button', { name: 'Dismiss: Travel budget reached' })).toHaveFocus()
  })

  it('drops the focus move when the caller keeps the item, so a later render does not replay it', async () => {
    const user = userEvent.setup()
    function KeepingCaller() {
      const [tick, setTick] = useState(0)
      return (
        <div>
          <button type="button" onClick={() => setTick((t) => t + 1)}>
            Rerender {tick}
          </button>
          {/* A fresh array each render, as the dashboard builds it. */}
          <AttentionList items={ITEMS.map((item) => ({ ...item }))} onDismiss={() => {}} />
        </div>
      )
    }
    render(<KeepingCaller />)
    await user.click(screen.getByRole('button', { name: 'Dismiss: Re-approval needed' }))
    const rerender = screen.getByRole('button', { name: /Rerender/ })
    await user.click(rerender)
    expect(rerender).toHaveFocus()
  })

  it('moves focus to the heading when the last dismissible row goes, even with rows left', async () => {
    const user = userEvent.setup()
    renderList([{ ...ITEMS[0], dismissible: false }, ITEMS[1]], 'list-heading')
    await user.click(screen.getByRole('button', { name: 'Dismiss: Re-approval needed' }))
    // The non-dismissible row stays; there is no dismiss button left to land on.
    expect(screen.getByRole('list')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Needs attention' })).toHaveFocus()
  })
})
