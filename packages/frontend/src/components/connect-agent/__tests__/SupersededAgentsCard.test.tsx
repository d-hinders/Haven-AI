import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SupersededAgentsCard } from '../SupersededAgentsCard'

/**
 * The other-agents list in the connect modal's done state (#2561, #3830).
 *
 * The heaviest tests here are the ones about NOT rendering. A connector run
 * that could not read the credential root reports `null`, and a card that
 * treated that as "scanned, found none" would silently reassure somebody about
 * a machine nobody managed to look at.
 *
 * The others pin #3830: `superseded_agent_ids` is every other agent folder on
 * the machine, not a replace set, so the card never says "replaced" and never
 * offers a revoke (owner decision 2026-10-09) — revoking stays on each agent's
 * own page.
 */

type MockAgent = {
  id: string
  name: string
  status: string
  account_id?: string | null
  account_chain_id?: number | null
}

const { mockRevoke, mockAgents } = vi.hoisted(() => ({
  mockRevoke: vi.fn(),
  mockAgents: { current: [] as MockAgent[] },
}))

const { mockState } = vi.hoisted(() => ({
  mockState: {
    error: null as string | null,
    loading: false,
    refetch: (() => {}) as () => void,
  },
}))

vi.mock('@/hooks/useAgents', () => ({
  useAgents: () => ({
    agents: mockAgents.current,
    loading: mockState.loading,
    error: mockState.error,
    refetch: mockState.refetch,
    // Present so a regression that called it would be observable.
    revokeAgent: mockRevoke,
  }),
}))

const OWNED: MockAgent[] = [
  { id: 'agt_old', name: 'Research agent', status: 'active', account_id: 'acc-1', account_chain_id: 84532 },
  { id: 'agt_other', name: 'Ops agent', status: 'active', account_id: 'acc-1', account_chain_id: 84532 },
]

beforeEach(() => {
  vi.clearAllMocks()
  mockAgents.current = OWNED
  mockState.error = null
  mockState.loading = false
  mockState.refetch = vi.fn()
})

describe('SupersededAgentsCard', () => {
  describe('lists the other agents, and claims nothing it cannot know (#3830)', () => {
    it('lists one agent the connector found, with no "replaced" and no revoke', () => {
      const { container } = render(<SupersededAgentsCard supersededAgentIds={['agt_old']} />)

      expect(
        screen.getByRole('heading', { name: 'Another agent on this machine is still active' }),
      ).toBeInTheDocument()
      expect(screen.getByText('Research agent')).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Open Research agent' })).toHaveAttribute(
        'href',
        '/agents/agt_old',
      )
      // Owner decision 2026-10-09: list them, no revoke offer.
      expect(screen.queryByRole('button', { name: /revoke/i })).not.toBeInTheDocument()
      // True for ANY reported id, so none of these may appear.
      expect(container.textContent ?? '').not.toMatch(/replaced|previous|earlier agent|unchanged|did not change/i)
    })

    it('the plural title says the same, without "replaced"', () => {
      const { container } = render(
        <SupersededAgentsCard supersededAgentIds={['agt_old', 'agt_other']} />,
      )

      expect(
        screen.getByRole('heading', { name: '2 other agents on this machine are still active' }),
      ).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Open Research agent' })).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Open Ops agent' })).toBeInTheDocument()
      expect(screen.queryAllByRole('button')).toHaveLength(0)
      expect(container.textContent ?? '').not.toMatch(/replaced|previous|earlier agent/i)
    })

    it('revokes nothing, on render or on following a link', async () => {
      render(<SupersededAgentsCard supersededAgentIds={['agt_old', 'agt_other']} />)
      await userEvent.click(screen.getByRole('link', { name: 'Open Research agent' }))
      expect(mockRevoke).not.toHaveBeenCalled()
    })
  })

  describe('what it refuses to say', () => {
    it('renders NOTHING when the scan could not run', () => {
      // `null` is the whole reason this field is a tri-state. Rendering
      // "nothing here" would be Haven asserting something about a machine it
      // failed to read.
      const { container } = render(<SupersededAgentsCard supersededAgentIds={null} />)
      expect(container).toBeEmptyDOMElement()
    })

    it('renders nothing when the report is absent entirely', () => {
      const { container } = render(<SupersededAgentsCard />)
      expect(container).toBeEmptyDOMElement()
    })

    it('renders nothing when the scan ran and found none', () => {
      // Same silence, different reason — and correct: there is nothing to list.
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
        expect(container.textContent ?? '').not.toMatch(/nothing to revoke|no (other )?agents|all clear/i)
        unmount()
      }
    })

    it('says so when the AGENT LIST could not be read, rather than going quiet', async () => {
      // The mirror of this component's own rule, and the one it originally
      // missed: it applies the scanned-vs-unscanned discipline to the report
      // and then reads the owner's agents itself, a read that can fail. After
      // it does, `agents` stays empty for good — and rendering nothing then
      // looks exactly like "there are no other agents here", about a list we
      // know is not empty.
      mockAgents.current = []
      mockState.error = 'We could not load connected agents.'
      const { container } = render(<SupersededAgentsCard supersededAgentIds={['agt_old']} />)

      expect(screen.getByText(/Other agents may be set up on this machine/i)).toBeInTheDocument()
      expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument()
      // #3830: no claim that this setup replaced anything, and no revoke.
      expect(container.textContent ?? '').not.toMatch(/replaced/i)
      expect(screen.queryByRole('button', { name: /revoke/i })).not.toBeInTheDocument()

      await userEvent.click(screen.getByRole('button', { name: /try again/i }))
      expect(mockState.refetch).toHaveBeenCalled()
      // The default mock returns `undefined`, which is the shape that threw:
      // the handler called `.finally` on it. Asserting the button recovers
      // proves the handler survived rather than dying inside the click.
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /try again/i })).not.toBeDisabled(),
      )
    })

    it('says NOTHING on a first load that has not finished', () => {
      // The bug this replaces, and the worst of the session: the retry fix
      // branched on `useAgents`' `loading`, which is `true` on first mount
      // before anything has failed — so a freshly completed setup announced
      // that the agent list could not be read. A false claim, on the one
      // screen this whole flow exists to make trustworthy.
      //
      // Worse, the test that stood here ASSERTED that as correct. It set
      // exactly this state and expected the error card. A test can enshrine a
      // defect as thoroughly as it can catch one.
      mockAgents.current = []
      mockState.error = null
      mockState.loading = true
      const { container } = render(<SupersededAgentsCard supersededAgentIds={['agt_old']} />)
      expect(container).toBeEmptyDOMElement()
    })

    it('stays visible while a RETRY it started is in flight', async () => {
      // The real case the loading branch was reaching for: `refetch` clears
      // `error` synchronously before the request settles, so branching on the
      // error alone made the card — and the button just clicked — vanish.
      // Keyed on this card's own retry rather than on any load in flight.
      mockAgents.current = []
      mockState.error = 'We could not load connected agents.'
      // The mock must CLEAR the error the way the real `fetchAgents` does —
      // synchronously, before the request settles. Without that this test
      // passes on `error` alone and proves nothing about the retry flag: a
      // mutation removing the flag survived until this line existed.
      let release: () => void = () => {}
      mockState.refetch = vi.fn(() => {
        mockState.error = null
        return new Promise<void>((resolve) => { release = () => resolve() })
      })
      render(<SupersededAgentsCard supersededAgentIds={['agt_old']} />)

      await userEvent.click(screen.getByRole('button', { name: /try again/i }))
      const busy = await screen.findByRole('button', { name: /checking/i })
      expect(busy).toBeDisabled()
      expect(screen.getByText(/Other agents may be set up on this machine/i)).toBeInTheDocument()

      // A retry that succeeds resolves into the truth it found — here, the
      // list it could not show before. It does not return to a "Try again"
      // it no longer needs.
      mockAgents.current = OWNED
      release()
      expect(await screen.findByRole('link', { name: 'Open Research agent' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /try again|checking/i })).not.toBeInTheDocument()
    })

    it('stays silent while loading when nothing was reported', () => {
      mockAgents.current = []
      mockState.loading = true
      const { container } = render(<SupersededAgentsCard supersededAgentIds={[]} />)
      expect(container).toBeEmptyDOMElement()
    })

    it('stays silent when the read fails but nothing was reported', () => {
      // A failed read with nothing to say about has nothing to say.
      mockAgents.current = []
      mockState.error = 'We could not load connected agents.'
      const { container } = render(<SupersededAgentsCard supersededAgentIds={[]} />)
      expect(container).toBeEmptyDOMElement()
    })

    it('ignores ids this owner does not have', () => {
      // The connector falls back to a DIRECTORY NAME when an identity.json
      // will not parse, so the report can name things that are not agents —
      // or agents belonging to somebody else. Listing those would be a claim
      // Haven cannot support.
      const { container } = render(
        <SupersededAgentsCard supersededAgentIds={['.DS_Store', 'agt_someone_elses', 'weird-dir']} />,
      )
      expect(container).toBeEmptyDOMElement()
    })

    it('does not list an agent that is already revoked', () => {
      mockAgents.current = [{ id: 'agt_old', name: 'Research agent', status: 'revoked' }]
      const { container } = render(<SupersededAgentsCard supersededAgentIds={['agt_old']} />)
      expect(container).toBeEmptyDOMElement()
    })
  })

})
