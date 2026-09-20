import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LabelChip, LabelChipRow, LabelOptionRow } from '../LabelChip'
import type { AgentLabel } from '../LabelChip'

function label(id: string, name: string, color: string): AgentLabel {
  return { id, name, color, created_at: '2026-05-01T00:00:00Z' } as AgentLabel
}

describe('LabelChip', () => {
  it('renders the label name in a chip', () => {
    render(<LabelChip label={label('1', 'prod', 'brand')} />)
    expect(screen.getByText('prod')).toBeInTheDocument()
  })

  it('paints each palette colour from its v2 token pair, never raw hex', () => {
    const { container, rerender } = render(<LabelChip label={label('1', 'a', 'brand')} />)
    expect(container.firstElementChild?.className).toContain('bg-[var(--v2-brand-soft)]')
    expect(container.firstElementChild?.className).toContain('text-[var(--v2-brand)]')

    rerender(<LabelChip label={label('1', 'a', 'success')} />)
    expect(container.firstElementChild?.className).toContain('bg-[var(--v2-success-soft)]')

    rerender(<LabelChip label={label('1', 'a', 'debit')} />)
    expect(container.firstElementChild?.className).toContain('bg-[var(--v2-debit-soft)]')

    rerender(<LabelChip label={label('1', 'a', 'neutral')} />)
    expect(container.firstElementChild?.className).toContain('bg-[var(--v2-surface-2)]')
    // The palette deliberately excludes the semantic tints (issue #3167):
    expect(container.firstElementChild?.className).not.toContain('warning')
    expect(container.firstElementChild?.className).not.toContain('danger')
  })
})

describe('LabelChipRow', () => {
  it('renders nothing for an unlabelled agent', () => {
    const { container } = render(<LabelChipRow labels={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows up to three chips and folds the rest into a +N counter', () => {
    const labels = [
      label('1', 'prod', 'brand'),
      label('2', 'finance', 'debit'),
      label('3', 'experimental', 'success'),
      label('4', 'test-agents', 'neutral'),
      label('5', 'recurring', 'neutral'),
    ]
    render(<LabelChipRow labels={labels} />)
    expect(screen.getByText('prod')).toBeInTheDocument()
    expect(screen.getByText('finance')).toBeInTheDocument()
    expect(screen.getByText('experimental')).toBeInTheDocument()
    expect(screen.queryByText('test-agents')).not.toBeInTheDocument()
    expect(screen.getByText('+2')).toBeInTheDocument()
    // The counter names what it dropped.
    expect(screen.getByText('+2')).toHaveAttribute('title', 'test-agents, recurring')
  })

  it('shows no counter at exactly three labels', () => {
    const labels = [label('1', 'a', 'brand'), label('2', 'b', 'debit'), label('3', 'c', 'success')]
    render(<LabelChipRow labels={labels} />)
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument()
  })
})

describe('LabelOptionRow', () => {
  it('renders a checkbox whose accessible name is the label name', () => {
    render(
      <LabelOptionRow
        label={label('1', 'prod', 'brand')}
        checked={false}
        onToggle={() => {}}
      />,
    )
    expect(screen.getByRole('checkbox', { name: 'prod' })).not.toBeChecked()
  })
})
