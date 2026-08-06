import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Card } from '../Card'

describe('Card.Header', () => {
  it('renders the title in an h3 by default and h2 via as', () => {
    const { rerender } = render(<Card.Header title="Connected agents" />)
    expect(screen.getByRole('heading', { level: 3, name: 'Connected agents' })).toBeInTheDocument()

    rerender(<Card.Header as="h2" title="Connected agents" />)
    expect(screen.getByRole('heading', { level: 2, name: 'Connected agents' })).toBeInTheDocument()
  })

  it('renders description and actions alongside the title', () => {
    render(
      <Card.Header
        title="Saved recipients"
        description="Use names for people you pay often."
        actions={<button type="button">Add contact</button>}
      />,
    )
    expect(screen.getByText('Use names for people you pay often.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add contact' })).toBeInTheDocument()
  })

  it('skips the slot wrapper for bespoke children (no heading rendered)', () => {
    render(
      <Card.Header>
        <span>bespoke content</span>
      </Card.Header>,
    )
    expect(screen.getByText('bespoke content')).toBeInTheDocument()
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
  })

  it('applies the padding variants', () => {
    const { container, rerender } = render(<Card.Header title="t" />)
    expect(container.firstElementChild?.className).toContain('px-5 py-4')

    rerender(<Card.Header title="t" padding="spacious" />)
    expect(container.firstElementChild?.className).toContain('px-6 py-5')

    rerender(<Card.Header title="t" padding="none" className="px-3 py-1.5" />)
    expect(container.firstElementChild?.className).not.toContain('px-5 py-4')
    expect(container.firstElementChild?.className).toContain('px-3 py-1.5')
  })
})
