import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NoticeRow } from '@/components/haven/NoticeRow'

/**
 * The NoticeRow contract (#3845): a sentence plus at most one action, the
 * action under the text below `sm` and on the same line from `sm` up, and the
 * outer margin taken from the caller.
 */
describe('NoticeRow', () => {
  it('renders the message and the action, the action after the text', () => {
    render(
      <NoticeRow action={<button type="button">Try again</button>}>
        Haven could not load how this account is approved.
      </NoticeRow>,
    )
    const message = screen.getByText('Haven could not load how this account is approved.')
    const action = screen.getByRole('button', { name: 'Try again' })
    expect(message.tagName).toBe('P')
    // DOM order is reading order: the action follows the sentence it resolves.
    expect(message.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('stacks the action under the text below sm and puts it on the line from sm up', () => {
    render(
      <NoticeRow action={<button type="button">Connect wallet</button>}>
        Connect your account owner wallet to change or stop a budget.
      </NoticeRow>,
    )
    const row = screen.getByText(/Connect your account owner wallet/).parentElement as HTMLElement
    const classes = row.className.split(/\s+/)
    // Mobile: a column, so the action is on its own line under the text.
    expect(classes).toEqual(expect.arrayContaining(['flex', 'flex-col', 'items-start']))
    // From sm: one row, the action pushed to the end.
    expect(classes).toEqual(
      expect.arrayContaining(['sm:flex-row', 'sm:items-center', 'sm:justify-between']),
    )
    expect(classes).not.toContain('flex-row')
  })

  it('renders no action wrapper without an action', () => {
    const { container } = render(<NoticeRow>Nothing to do here.</NoticeRow>)
    expect(screen.getByText('Nothing to do here.')).toBeInTheDocument()
    expect(container.querySelector('[data-notice-action]')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('takes its outer margin from the caller', () => {
    const { container } = render(<NoticeRow className="mb-5">Spaced.</NoticeRow>)
    expect((container.firstChild as HTMLElement).className.split(/\s+/)).toContain('mb-5')
  })
})
