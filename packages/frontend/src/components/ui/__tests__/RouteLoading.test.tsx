import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RouteLoading } from '@/components/ui/RouteLoading'

/**
 * The one route and auth fallback (#4568). Ten call sites hand-copied this
 * block; these assertions are the contract they now share.
 */
describe('RouteLoading (#4568)', () => {
  it('is a polite busy status whose visible label is also its accessible name', () => {
    render(<RouteLoading />)

    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-busy', 'true')
    expect(status).toHaveAttribute('aria-live', 'polite')
    // The label is VISIBLE — not an sr-only string — and it is the name the
    // status region announces.
    expect(status).toHaveTextContent('Loading…')
    expect(screen.getByText('Loading…')).toBeVisible()
    expect(status).toHaveAccessibleName('Loading…')
  })

  it('uses a real ellipsis, never ASCII dots', () => {
    render(<RouteLoading />)
    expect(screen.getByText('Loading…').textContent).toBe('Loading\u2026')
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
  })

  it('takes a more specific label where the fallback says more than "loading"', () => {
    render(<RouteLoading label="Loading account…" />)
    expect(screen.getByRole('status')).toHaveAccessibleName('Loading account…')
  })

  it('renders the brand dot through Skeleton, not an inline animate-pulse div', () => {
    const { container } = render(<RouteLoading />)
    const dot = container.querySelector('[aria-hidden="true"]')
    expect(dot).not.toBeNull()
    expect(dot!.className).toContain('animate-pulse')
    expect(dot!.className).toContain('rounded-full')
    expect(dot!.className).toContain('bg-[var(--v2-brand)]')
  })

  it('carries the caller layout on the row, so the page wrapper stays at the call site', () => {
    const { container } = render(<RouteLoading className="p-8 justify-center" />)
    const row = container.firstElementChild!
    expect(row.className).toContain('flex')
    expect(row.className).toContain('items-center')
    expect(row.className).toContain('gap-3')
    expect(row.className).toContain('p-8')
    expect(row.className).toContain('justify-center')
  })
})
