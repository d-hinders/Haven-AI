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

  it('owns no live region and no progress signal', () => {
    const { container } = render(<ConnectAgentRow name="Research agent" state="waiting" />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    // The checklist owns progress: no counter, no badge, no step number here.
    expect(container.textContent).not.toMatch(/\d+\s*(of|\/)\s*\d+/)
  })
})
