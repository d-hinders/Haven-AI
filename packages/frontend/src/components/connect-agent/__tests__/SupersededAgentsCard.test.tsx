import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SupersededAgentsCard } from '../SupersededAgentsCard'

/**
 * The superseded-agent revoke offer (#2561).
 *
 * The heaviest tests here are the ones about NOT rendering. A connector run
 * that could not read the credential root reports `null`, and a card that
 * treated that as "scanned, found none" would silently reassure somebody about
 * a machine nobody managed to look at. That is the failure this component was
 * built to avoid, so it is the failure most of these assert.
 */

const { mockRevoke, mockAgents } = vi.hoisted(() => ({
  mockRevoke: vi.fn(),
  mockAgents: { current: [] as Array<{ id: string; name: string; status: string }> },
}))

vi.mock('@/hooks/useAgents', () => ({
  useAgents: () => ({ agents: mockAgents.current, revokeAgent: mockRevoke }),
}))

const OWNED = [
  { id: 'agt_old', name: 'Research agent', status: 'active' },
  { id: 'agt_other', name: 'Ops agent', status: 'active' },
]

beforeEach(() => {
  vi.clearAllMocks()
  mockAgents.current = OWNED
  mockRevoke.mockResolvedValue(undefined)
})

describe('SupersededAgentsCard', () => {
  it('offers a revoke for an agent the connector superseded', async () => {
    render(<SupersededAgentsCard supersededAgentIds={['agt_old']} />)
    expect(screen.getByText(/replaced an earlier agent/i)).toBeInTheDocument()
    expect(screen.getByText('Research agent')).toBeInTheDocument()
    // The other owned agent was not reported, so it is not offered.
    expect(screen.queryByText('Ops agent')).not.toBeInTheDocument()
  })

  describe('what it refuses to say', () => {
    it('renders NOTHING when the scan could not run', () => {
      // `null` is the whole reason this field is a tri-state. Rendering
      // "nothing to revoke" here would be Haven asserting something about a
      // machine it failed to read.
      const { container } = render(<SupersededAgentsCard supersededAgentIds={null} />)
      expect(container).toBeEmptyDOMElement()
    })

    it('renders nothing when the report is absent entirely', () => {
      const { container } = render(<SupersededAgentsCard />)
      expect(container).toBeEmptyDOMElement()
    })

    it('renders nothing when the scan ran and found none', () => {
      // Same silence, different reason — and correct: there is nothing to offer.
      const { container } = render(<SupersededAgentsCard supersededAgentIds={[]} />)
      expect(container).toBeEmptyDOMElement()
    })

    it('is silent for all three empty cases, and says nothing about which', () => {
      // The property this component actually has, pinned honestly. A mutation
      // that removed the null short-circuit passed every other test here,
      // because the intersection below already produces the same silence — so
      // the tests should assert the silence, not a guard that is not doing the
      // work. The tri-state itself is preserved on the wire and asserted
      // there (`superseded-agent-ids.test.ts` in the backend).
      for (const value of [null, undefined, [] as string[], ['not_mine']]) {
        const { container, unmount } = render(
          <SupersededAgentsCard supersededAgentIds={value} />,
        )
        expect(container, String(value)).toBeEmptyDOMElement()
        // And in particular: never the sentence that would be a lie for the
        // unscanned machine.
        expect(container.textContent ?? '').not.toMatch(/nothing to revoke|no agents|all clear/i)
        unmount()
      }
    })

    it('ignores ids this owner does not have', () => {
      // The connector falls back to a DIRECTORY NAME when an identity.json
      // will not parse, so the report can name things that are not agents —
      // or agents belonging to somebody else. Offering those would be an
      // action the user cannot take, on a claim Haven cannot support.
      const { container } = render(
        <SupersededAgentsCard supersededAgentIds={['.DS_Store', 'agt_someone_elses', 'weird-dir']} />,
      )
      expect(container).toBeEmptyDOMElement()
      expect(mockRevoke).not.toHaveBeenCalled()
    })

    it('does not offer an agent that is already revoked', () => {
      mockAgents.current = [{ id: 'agt_old', name: 'Research agent', status: 'revoked' }]
      const { container } = render(<SupersededAgentsCard supersededAgentIds={['agt_old']} />)
      expect(container).toBeEmptyDOMElement()
    })
  })

  describe('nothing is revoked without a click', () => {
    it('revokes nothing on render', () => {
      render(<SupersededAgentsCard supersededAgentIds={['agt_old', 'agt_other']} />)
      expect(mockRevoke).not.toHaveBeenCalled()
    })

    it('asks for confirmation before revoking, and the first click does not revoke', async () => {
      render(<SupersededAgentsCard supersededAgentIds={['agt_old']} />)
      await userEvent.click(screen.getByRole('button', { name: /^revoke$/i }))

      // A confirm step stands between the offer and the action.
      expect(await screen.findByText(/Revoke Research agent\?/i)).toBeInTheDocument()
      expect(mockRevoke).not.toHaveBeenCalled()

      await userEvent.click(screen.getByRole('button', { name: /revoke agent/i }))
      await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith('agt_old'))
    })

    it('cancelling leaves the agent alone', async () => {
      render(<SupersededAgentsCard supersededAgentIds={['agt_old']} />)
      await userEvent.click(screen.getByRole('button', { name: /^revoke$/i }))
      await userEvent.click(await screen.findByRole('button', { name: /keep it/i }))
      expect(mockRevoke).not.toHaveBeenCalled()
      // And the offer is still there — cancelling is not dismissing.
      expect(screen.getByText('Research agent')).toBeInTheDocument()
    })

    it('revokes one agent per confirmation, never the whole list', async () => {
      render(<SupersededAgentsCard supersededAgentIds={['agt_old', 'agt_other']} />)
      expect(screen.getAllByRole('button', { name: /^revoke$/i })).toHaveLength(2)

      await userEvent.click(screen.getAllByRole('button', { name: /^revoke$/i })[0])
      await userEvent.click(await screen.findByRole('button', { name: /revoke agent/i }))
      await waitFor(() => expect(mockRevoke).toHaveBeenCalledTimes(1))
      expect(mockRevoke).toHaveBeenCalledWith('agt_old')
    })
  })

  it('names WHICH agent is still live when a revoke fails', async () => {
    // A shared banner would leave the user guessing across several agents.
    mockRevoke.mockRejectedValue(new Error('Agent not found'))
    render(<SupersededAgentsCard supersededAgentIds={['agt_old']} />)
    await userEvent.click(screen.getByRole('button', { name: /^revoke$/i }))
    await userEvent.click(await screen.findByRole('button', { name: /revoke agent/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Agent not found')
    // Still offered — a failed revoke has not retired anything.
    expect(screen.getByText('Research agent')).toBeInTheDocument()
  })

  it('says the revoke is irreversible before it is taken', async () => {
    render(<SupersededAgentsCard supersededAgentIds={['agt_old']} />)
    await userEvent.click(screen.getByRole('button', { name: /^revoke$/i }))
    expect(await screen.findByText(/cannot be undone/i)).toBeInTheDocument()
    expect(screen.getByText(/stops working immediately/i)).toBeInTheDocument()
  })
})
