import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/AgentPanel', () => ({
  default: () => null,
}))

import AgentsPage from '../page'

describe('/agents page header (#4065)', () => {
  it('says what an agent is and who approves its budget', () => {
    render(<AgentsPage />)

    expect(screen.getByRole('heading', { level: 1, name: 'Agents' })).toBeInTheDocument()
    // Owner decision 2026-10-19: "yourself", not "with your passkey" — an
    // account can approve with a wallet signer too.
    expect(
      screen.getByText(
        'Agents pay for things up to a budget you set. You approve each budget yourself, and anything over it is refused on-chain.',
      ),
    ).toBeInTheDocument()
  })
})
