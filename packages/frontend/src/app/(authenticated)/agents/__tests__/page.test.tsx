import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/AgentPanel', () => ({
  default: () => <div data-testid="agent-panel" />,
}))

import AgentsPage from '../page'

// #4209: the page header (title, subtitle, Connect agent, ⋯ menu) renders
// inside `AgentPanel`, beside the state it reads; its wording is asserted in
// `AgentPanel.test.tsx` ("AgentPanel page header"). The route renders only the
// panel — a second header here would put two `h1`s on the page.
describe('/agents page (#4065, #4209)', () => {
  it('renders the panel and no header of its own', () => {
    render(<AgentsPage />)

    expect(screen.getByTestId('agent-panel')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  })
})
