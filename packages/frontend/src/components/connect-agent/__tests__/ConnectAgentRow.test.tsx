import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ConnectAgentRow } from '@/components/connect-agent/ConnectAgentRow'

/**
 * #4702: the connect flow's agent row says WHO you are waiting for, not how far
 * along the flow is. It is presentational and owns no live region — the caller
 * announces the change once, alongside the row that changed.
 */
describe('ConnectAgentRow (#4702)', () => {
  it('names the agent and says it is listening while the connector runs', () => {
    render(<ConnectAgentRow name="Research agent" state="waiting" />)
    expect(screen.getByText('Research agent')).toBeTruthy()
    expect(screen.getByText('Listening for it…')).toBeTruthy()
  })

  it('says it connected once the agent lands', () => {
    render(<ConnectAgentRow name="Research agent" state="connected" />)
    expect(screen.getByText('Research agent')).toBeTruthy()
    expect(screen.getByText('Connected just now')).toBeTruthy()
    expect(screen.queryByText('Listening for it…')).toBeNull()
  })

  it('marks the connected state on the agent mark, and only the connected state (owner review on #4728)', () => {
    const { rerender } = render(<ConnectAgentRow name="Research agent" state="waiting" />)
    expect(screen.queryByTestId('connect-agent-row-connected-mark')).toBeNull()
    rerender(<ConnectAgentRow name="Research agent" state="connected" />)
    const mark = screen.getByTestId('connect-agent-row-connected-mark')
    // Decorative: the subtitle carries the words, and the mark adds no text.
    expect(mark.getAttribute('aria-hidden')).toBe('true')
    expect(mark.textContent).toBe('')
    expect(mark.className).toContain('bg-[var(--v2-success)]')
  })

  it('owns no live region and no progress signal', () => {
    const { container } = render(<ConnectAgentRow name="Research agent" state="waiting" />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    // The checklist owns progress: no counter, no badge, no step number here.
    expect(container.textContent).not.toMatch(/\d+\s*(of|\/)\s*\d+/)
  })
})
