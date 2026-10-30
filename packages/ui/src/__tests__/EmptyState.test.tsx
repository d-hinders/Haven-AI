import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EmptyState } from '../EmptyState'

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

  // #4563: the in-card form. Inside a `Card` the dashed `--v2-surface` shell
  // would be a second filled surface, which CLAUDE.md § UI Surface Hierarchy
  // forbids — so `bare` drops the shell and keeps everything else.
  it('bare drops the shell — no dashed border, no filled surface — and keeps the content', () => {
    const { container } = render(
      <EmptyState
        bare
        icon={<span data-testid="icon" />}
        title="No payments yet"
        body="Payments your agents make appear here."
        action={<button>Connect an agent</button>}
      />,
    )
    const root = container.firstElementChild!
    expect(root.className).not.toContain('border-dashed')
    expect(root.className).not.toContain('bg-[var(--v2-surface)]')
    expect(root.className).not.toContain('rounded-[10px]')
    // Everything the shell used to wrap still renders.
    expect(screen.getByTestId('icon')).toBeTruthy()
    expect(screen.getByText('No payments yet')).toBeTruthy()
    expect(screen.getByText('Payments your agents make appear here.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect an agent' })).toBeTruthy()
  })

  it('bare is orthogonal to size — compact keeps its density without the shell', () => {
    const { container } = render(
      <EmptyState bare size="compact" title="Preview unavailable" body="Try again soon." />,
    )
    const root = container.firstElementChild!
    expect(root.className).not.toContain('border-dashed')
    expect(root.className).toContain('p-6')
    expect(screen.getByText('Preview unavailable').className).toContain('font-medium')
  })

  it('bare inline keeps the one-line shape and drops the shell', () => {
    const { container } = render(<EmptyState bare size="inline" title="No budget set yet" />)
    const root = container.firstElementChild!
    expect(root.className).not.toContain('border-dashed')
    expect(root.className).toContain('px-3')
    expect(root.textContent).toBe('No budget set yet')
  })
})
