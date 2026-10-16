import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StepProgress } from '../StepProgress'

describe('StepProgress', () => {
  it('names each step by its label and marks the active one', () => {
    render(<StepProgress totalSteps={3} currentStep={1} labels={['Name', 'Budget', 'Connect']} />)

    expect(screen.getByLabelText('Step 1 of 3: Name')).toHaveTextContent('✓')
    expect(screen.getByLabelText('Step 2 of 3: Budget')).toHaveAttribute('aria-current', 'step')
    expect(screen.getByLabelText('Step 3 of 3: Connect')).not.toHaveAttribute('aria-current')
    expect(screen.getByText('Budget')).toBeInTheDocument()
  })

  it('keeps the bare step numbering when no labels are passed', () => {
    render(<StepProgress totalSteps={2} currentStep={0} />)

    expect(screen.getByLabelText('Step 1 of 2')).toHaveTextContent('1')
    expect(screen.getByLabelText('Step 2 of 2')).toHaveTextContent('2')
  })

  it('stretches every connector to fill the width', () => {
    const { container } = render(<StepProgress totalSteps={3} currentStep={0} />)

    const connectors = container.querySelectorAll('.v2-progress-line')
    expect(connectors).toHaveLength(2)
    connectors.forEach((line) => expect(line).toHaveClass('flex-1'))
  })
})
