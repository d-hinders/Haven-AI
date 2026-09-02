import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { InlineAlert } from '@/components/ui/InlineAlert'

describe('InlineAlert', () => {
  it('owns the assertive semantics and danger treatment while preserving linked content', () => {
    render(
      <InlineAlert id="resource-url-error">
        Check the <a href="/help">setup guide</a> and try again.
      </InlineAlert>,
    )

    const alert = screen.getByRole('alert')
    expect(alert).toHaveAttribute('id', 'resource-url-error')
    expect(alert).toHaveClass('text-xs', 'text-[var(--v2-danger)]')
    expect(screen.getByRole('link', { name: 'setup guide' })).toHaveAttribute('href', '/help')
  })
})
