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
})
