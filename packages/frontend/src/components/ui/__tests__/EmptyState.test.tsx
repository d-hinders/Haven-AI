import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EmptyState } from '@/components/ui/EmptyState'

describe('EmptyState (#854)', () => {
  it('default size renders the roomy dashed tile with icon halo, body, and action', () => {
    const { container } = render(
      <EmptyState
        icon={<span data-testid="icon" />}
        title="No agents yet"
        body="Create an agent."
        action={<button>Create</button>}
      />,
    )
    const shell = container.firstElementChild!
    expect(shell.className).toContain('border-dashed')
    expect(shell.className).toContain('py-10')
    expect(screen.getByText('No agents yet').className).toContain('font-semibold')
    expect(screen.getByTestId('icon')).toBeTruthy()
    expect(screen.getByText('Create')).toBeTruthy()
  })

  it('compact size tightens padding and type for in-card previews', () => {
    const { container } = render(
      <EmptyState size="compact" title="Preview unavailable" body="Try again soon." />,
    )
    const shell = container.firstElementChild!
    expect(shell.className).toContain('border-dashed')
    expect(shell.className).toContain('p-6')
    expect(shell.className).not.toContain('py-10')
    expect(screen.getByText('Preview unavailable').className).toContain('font-medium')
    expect(screen.getByText('Try again soon.').className).toContain('text-xs')
  })

  it('inline size renders a one-line placeholder — title only', () => {
    const { container } = render(
      <EmptyState
        size="inline"
        title="No budget set yet"
        body="never rendered"
        action={<button>never rendered</button>}
      />,
    )
    const shell = container.firstElementChild!
    expect(shell.className).toContain('border-dashed')
    expect(shell.textContent).toBe('No budget set yet')
    expect(screen.queryByRole('button')).toBeNull()
  })
})
