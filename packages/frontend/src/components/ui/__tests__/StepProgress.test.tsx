import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StepProgress } from '../StepProgress'

describe('StepProgress', () => {
  it('exposes each step as a list item named by its position and label', () => {
    render(<StepProgress totalSteps={3} currentStep={1} labels={['Name', 'Budget', 'Connect']} />)

    // textContent includes the aria-hidden numeral; assistive tech skips it.
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent(/^Step 1 of 3, completed: Name$/)
    expect(items[1]).toHaveTextContent(/^Step 2 of 3: 2Budget$/)
    expect(items[1]).toHaveAttribute('aria-current', 'step')
    expect(items[2]).not.toHaveAttribute('aria-current')
  })

  it('keeps the disc glyph decorative so the label is what is read', () => {
    const { container } = render(<StepProgress totalSteps={2} currentStep={1} labels={['Reason', 'Approve']} />)

    container.querySelectorAll('.rounded-full').forEach((disc) => expect(disc).toHaveAttribute('aria-hidden', 'true'))
    expect(screen.getByText('Approve')).not.toHaveAttribute('aria-hidden')
  })

  it('draws a completed step with the lucide check ConnectSteps uses, not a text glyph', () => {
    const { container } = render(<StepProgress totalSteps={2} currentStep={1} />)

    const done = container.querySelector('li')!
    expect(done).not.toHaveTextContent('✓')
    const check = done.querySelector('svg.lucide-check')
    expect(check).not.toBeNull()
    // Same size and stroke as ConnectSteps' done marker, so the two match side by side.
    expect(check).toHaveClass('h-3.5', 'w-3.5')
    expect(check).toHaveAttribute('stroke-width', '2')
    expect(check!.closest('[aria-hidden="true"]')).not.toBeNull()
  })

  it('renders a halted step neutral and no longer current', () => {
    const { container } = render(
      <StepProgress totalSteps={3} currentStep={2} labels={['Name', 'Budget', 'Connect']} halted />,
    )

    const items = screen.getAllByRole('listitem')
    expect(items[0]).toHaveTextContent(/^Step 1 of 3, completed: Name$/)
    expect(items[2]).toHaveTextContent(/^Step 3 of 3, stopped: 3Connect$/)
    items.forEach((item) => expect(item).not.toHaveAttribute('aria-current'))
    // No brand "in progress" ring anywhere on the band.
    expect(container.querySelector('[class*="border-[var(--v2-brand)]"]')).toBeNull()
  })

  it('keeps the bare step numbering when no labels are passed', () => {
    render(<StepProgress totalSteps={2} currentStep={0} />)

    const items = screen.getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('Step 1 of 2')
    expect(items[1]).toHaveTextContent('Step 2 of 2')
  })

  it('stretches every connector to fill the width', () => {
    const { container } = render(<StepProgress totalSteps={3} currentStep={0} />)

    const connectors = container.querySelectorAll('.v2-progress-line')
    expect(connectors).toHaveLength(2)
    connectors.forEach((line) => expect(line).toHaveClass('flex-1'))
  })
})
