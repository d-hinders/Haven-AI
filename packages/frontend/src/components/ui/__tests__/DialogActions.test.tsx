import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Button } from '../Button'
import { DialogActions } from '../DialogActions'

describe('DialogActions', () => {
  it('stacks primary-on-top below sm and lays out one row from sm, without reordering the markup', () => {
    render(
      <DialogActions>
        <Button variant="ghost" className="flex-1">
          Back
        </Button>
        <Button className="flex-1">Create setup prompt</Button>
      </DialogActions>,
    )
    const row = screen.getByRole('button', { name: 'Back' }).parentElement!
    // col-reverse puts the second child (the primary) on top on a phone.
    expect(row).toHaveClass('flex', 'flex-col-reverse', 'sm:flex-row')
    // flex-1's zero basis is a zero height in a column: the stacked buttons
    // collapsed to their text line at 375px until the children were reset.
    expect(row).toHaveClass('max-sm:[&>*]:flex-none')
    // Markup — and so Tab — order stays secondary, then primary.
    const buttons = screen.getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(['Back', 'Create setup prompt'])
  })

  // The Set budget dialog passed a ghost Cancel without `flex-1`: 78px beside
  // a 308px primary at 1288px. The equal split is the component's, not each
  // caller's, so a bare Button child still gets it.
  it('gives every child an equal share from sm up, even one without flex-1', () => {
    render(
      <DialogActions>
        <Button variant="ghost">Cancel</Button>
        <Button>Set budget</Button>
      </DialogActions>,
    )
    const row = screen.getByRole('button', { name: 'Cancel' }).parentElement!
    expect(row).toHaveClass('sm:[&>*]:flex-1')
    expect(screen.getByRole('button', { name: 'Cancel' })).not.toHaveClass('flex-1')
  })

  // In Modal's footer — a `justify-end` flex row — a pair with no width of its
  // own shrank to its content: the /design-system alternative-footer demo
  // never showed equal halves. A minimum, so a negative-margin outdent still
  // widens it (ROW_FOOTER_OUTDENT_CLASS).
  it('spans the full width of a flex-row footer without a caller className', () => {
    render(
      <div className="flex justify-end">
        <DialogActions>
          <Button variant="ghost">Cancel</Button>
          <Button>Save budget</Button>
        </DialogActions>
      </div>,
    )
    const row = screen.getByRole('button', { name: 'Cancel' }).parentElement!
    expect(row).toHaveClass('min-w-full')
    expect(row).not.toHaveClass('w-full')
  })
})
