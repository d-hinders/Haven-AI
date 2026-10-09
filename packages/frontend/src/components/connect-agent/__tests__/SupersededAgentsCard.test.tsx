import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SupersededAgentsCard } from '../SupersededAgentsCard'

// #3812: the in-flow connect/switch control reads wagmi and RainbowKit, which
// these tests do not provide. Stub it so the test can assert WHEN a flow
// offers it; `WalletConnectAction.test.tsx` covers what it does.
vi.mock('@/components/WalletConnectAction', () => ({
  default: () => <button type="button">Connect wallet</button>,
}))

/**
 * The superseded-agent revoke offer (#2561).
 *
 * The heaviest tests here are the ones about NOT rendering. A connector run
 * that could not read the credential root reports `null`, and a card that
 * treated that as "scanned, found none" would silently reassure somebody about
 * a machine nobody managed to look at. That is the failure this component was
 * built to avoid, so it is the failure most of these assert.
 */

type MockAgent = {
  id: string
  name: string
  status: string
  account_id?: string | null
  account_chain_id?: number | null
}

const { mockRevoke, mockAgents, mockRevokeAll, mockMarkBudgetEnded, mockBudgetHook, mockBudgetCalls } =
  vi.hoisted(() => ({
    mockRevoke: vi.fn(),
    mockAgents: { current: [] as MockAgent[] },
    mockRevokeAll: vi.fn(),
    mockMarkBudgetEnded: vi.fn(),
    mockBudgetHook: { ready: true, busy: false, signersLoading: false },
    // Every `useDelegationBudget(agentId, chainId)` call, so a test can assert
    // the hook is mounted for the agent pending confirmation ONLY, and on that
    // agent's own chain.
    mockBudgetCalls: [] as Array<[string, number]>,
  }))

vi.mock('@/hooks/useDelegationBudget', () => ({
  useDelegationBudget: (agentId: string, chainId: number) => {
    mockBudgetCalls.push([agentId, chainId])
    return {
      budgets: [{ id: 'd-1', status: 'active' }],
      budgetsError: false,
      revokeAll: mockRevokeAll,
      ready: mockBudgetHook.ready,
      busy: mockBudgetHook.busy,
      signersLoading: mockBudgetHook.signersLoading,
    }
  },
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
    revokeAgent: mockRevoke,
    markBudgetEnded: mockMarkBudgetEnded,
  }),
}))

const OWNED: MockAgent[] = [
  { id: 'agt_old', name: 'Research agent', status: 'active', account_id: 'acc-1', account_chain_id: 84532 },
  { id: 'agt_other', name: 'Ops agent', status: 'active', account_id: 'acc-1', account_chain_id: 84532 },
]

/** What the real `useAgents.revokeAgent` does on success: patch status locally. */
function revokeSucceeds() {
  mockRevoke.mockImplementation(async (id: string) => {
    mockAgents.current = mockAgents.current.map((a) =>
      a.id === id ? { ...a, status: 'revoked' } : a,
    )
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAgents.current = OWNED
  revokeSucceeds()
  mockRevokeAll.mockResolvedValue({ ok: true })
  mockBudgetHook.ready = true
  mockBudgetHook.busy = false
  mockBudgetHook.signersLoading = false
  mockBudgetCalls.length = 0
  mockState.error = null
  mockState.loading = false
  mockState.refetch = vi.fn()
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

    it('says so when the AGENT LIST could not be read, rather than going quiet', async () => {
      // The mirror of this component's own rule, and the one it originally
      // missed: it applies the scanned-vs-unscanned discipline to the report
      // and then reads the owner's agents itself, a read that can fail. After
      // it does, `agents` stays empty for good — and rendering nothing then
      // looks exactly like "this setup replaced nothing", about a list we know
      // is not empty.
      mockAgents.current = []
      mockState.error = 'We could not load connected agents.'
      render(<SupersededAgentsCard supersededAgentIds={['agt_old']} />)

      expect(screen.getByText(/may have replaced an earlier agent/i)).toBeInTheDocument()
      expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument()
      // It offers no revoke it cannot support, and says nothing changed.
      expect(screen.queryByRole('button', { name: /^Revoke / })).not.toBeInTheDocument()
      expect(screen.getByText(/Nothing has changed either way/i)).toBeInTheDocument()

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
      expect(screen.getByText(/may have replaced an earlier agent/i)).toBeInTheDocument()

      // A retry that succeeds resolves into the truth it found — here, the
      // offer it could not show before. It does not return to a "Try again"
      // it no longer needs.
      mockAgents.current = OWNED
      release()
      expect(await screen.findByRole('button', { name: 'Revoke Research agent' })).toBeInTheDocument()
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
      await userEvent.click(screen.getByRole('button', { name: 'Revoke Research agent' }))

      // A confirm step stands between the offer and the action.
      expect(await screen.findByText(/Revoke Research agent\?/i)).toBeInTheDocument()
      expect(mockRevoke).not.toHaveBeenCalled()

      await userEvent.click(screen.getByRole('button', { name: /revoke agent/i }))
      await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith('agt_old'))
    })

    it('opens the confirm with CANCEL focused, not the destructive button', async () => {
      // The finding this fix closes: the shared dialog focused its confirm on
      // open, and the modal focuses synchronously — so a keyboard user's second
      // Enter, an ordinary reflex right after the Enter that opened it,
      // confirmed a revoke. "Nothing happens without a deliberate click" was
      // not true for them.
      render(<SupersededAgentsCard supersededAgentIds={['agt_old']} />)
      await userEvent.click(screen.getByRole('button', { name: 'Revoke Research agent' }))
      await screen.findByRole('button', { name: /revoke agent/i })

      expect(screen.getByRole('button', { name: /keep it/i })).toHaveFocus()
      // And the reflex itself: Enter on the focused control cancels.
      await userEvent.keyboard('{Enter}')
      expect(mockRevoke).not.toHaveBeenCalled()
    })

    it('cancelling leaves the agent alone', async () => {
      render(<SupersededAgentsCard supersededAgentIds={['agt_old']} />)
      await userEvent.click(screen.getByRole('button', { name: 'Revoke Research agent' }))
      await userEvent.click(await screen.findByRole('button', { name: /keep it/i }))
      expect(mockRevoke).not.toHaveBeenCalled()
      // And the offer is still there — cancelling is not dismissing.
      expect(screen.getByText('Research agent')).toBeInTheDocument()
    })

    it('revokes one agent per confirmation, never the whole list', async () => {
      render(<SupersededAgentsCard supersededAgentIds={['agt_old', 'agt_other']} />)
      // Each button NAMES its agent. Two buttons both reading "Revoke" are
      // indistinguishable in a screen reader's forms list, which is exactly
      // the ambiguity that matters when the action is irreversible.
      expect(screen.getByRole('button', { name: 'Revoke Research agent' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Revoke Ops agent' })).toBeInTheDocument()

      await userEvent.click(screen.getByRole('button', { name: 'Revoke Research agent' }))
      await userEvent.click(await screen.findByRole('button', { name: /revoke agent/i }))
      await waitFor(() => expect(mockRevoke).toHaveBeenCalledTimes(1))
      expect(mockRevoke).toHaveBeenCalledWith('agt_old')
    })
  })

  it('names WHICH agent is still live when a revoke fails', async () => {
    // A shared banner would leave the user guessing across several agents.
    mockRevoke.mockRejectedValue(new Error('Agent not found'))
    render(<SupersededAgentsCard supersededAgentIds={['agt_old']} />)
    await userEvent.click(screen.getByRole('button', { name: 'Revoke Research agent' }))
    await userEvent.click(await screen.findByRole('button', { name: /revoke agent/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Agent not found')
    // Still offered — a failed revoke has not retired anything.
    expect(screen.getByText('Research agent')).toBeInTheDocument()
  })

  it('says the revoke is irreversible before it is taken', async () => {
    render(<SupersededAgentsCard supersededAgentIds={['agt_old']} />)
    await userEvent.click(screen.getByRole('button', { name: 'Revoke Research agent' }))
    expect(await screen.findByText(/cannot be undone/i)).toBeInTheDocument()
    expect(screen.getByText(/stops working immediately/i)).toBeInTheDocument()
  })

  /**
   * #3542 (B). `POST /agents/:id/revoke` only stops the credential; the budget
   * delegation stays redeemable on-chain until the owner signs revoke-all. This
   * card used to revoke the credential, claim "Revoking stops that" and "it
   * cannot spend again", and drop the row — leaving a live budget behind a
   * dead credential with nothing on screen saying so.
   */
  describe('revoking ends the budget too, not just the credential (#3542)', () => {
    async function openConfirm(name = 'Research agent') {
      await userEvent.click(screen.getByRole('button', { name: `Revoke ${name}` }))
      return screen.findByRole('button', { name: /^revoke agent$/i })
    }

    it('never claims spending ended before a signature landed', async () => {
      render(<SupersededAgentsCard supersededAgentIds={['agt_old']} />)
      // The list copy: the credential and the budget are named as two things.
      expect(screen.queryByText(/Revoking stops that/i)).not.toBeInTheDocument()
      expect(screen.getByText(/one signature from you ends its budget/i)).toBeInTheDocument()

      await openConfirm()
      expect(document.body.textContent).not.toMatch(/cannot spend again/i)
      expect(document.body.textContent).toMatch(/budget stays active/i)
    })

    it('revokes the credential first, THEN signs revoke-all — on the agent\'s own chain', async () => {
      const order: string[] = []
      mockRevoke.mockImplementation(async (id: string) => {
        order.push(`credential:${id}`)
        mockAgents.current = mockAgents.current.map((a) =>
          a.id === id ? { ...a, status: 'revoked' } : a,
        )
      })
      mockRevokeAll.mockImplementation(async () => {
        order.push('revokeAll')
        return { ok: true }
      })
      mockAgents.current = [
        { ...OWNED[0], account_chain_id: 100 },
        OWNED[1],
      ]
      render(<SupersededAgentsCard supersededAgentIds={['agt_old', 'agt_other']} />)

      await userEvent.click(await openConfirm())
      await waitFor(() => expect(mockMarkBudgetEnded).toHaveBeenCalledWith('agt_old'))
      expect(order).toEqual(['credential:agt_old', 'revokeAll'])
      // Mounted for the agent pending confirmation only — never one hook per
      // row — and on THAT agent's chain, not a default.
      expect(mockBudgetCalls.length).toBeGreaterThan(0)
      expect(new Set(mockBudgetCalls.map((c) => c.join('@')))).toEqual(new Set(['agt_old@100']))
      // Fully done: the row is gone, and nothing is left saying "still active".
      await waitFor(() => expect(screen.queryByText('Research agent')).not.toBeInTheDocument())
    })

    it('mounts no budget hook before anything is pending', () => {
      render(<SupersededAgentsCard supersededAgentIds={['agt_old', 'agt_other']} />)
      expect(mockBudgetCalls).toEqual([])
    })

    it('a cancelled signature leaves the credential revoked and says the budget is STILL active', async () => {
      mockRevokeAll.mockResolvedValue({ ok: false, reason: 'cancelled' })
      render(<SupersededAgentsCard supersededAgentIds={['agt_old']} />)

      await userEvent.click(await openConfirm())

      expect(mockRevoke).toHaveBeenCalledWith('agt_old')
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(/key is revoked, but its budget is still active/i)
      // The row stays, with the one action that finishes it.
      expect(screen.getByText('Research agent')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Finish revoking Research agent' })).toBeInTheDocument()
      expect(mockMarkBudgetEnded).not.toHaveBeenCalled()
    })

    it('a device that cannot sign still revokes the credential, and says the budget stays active', async () => {
      mockBudgetHook.ready = false
      render(<SupersededAgentsCard supersededAgentIds={['agt_old']} />)

      await userEvent.click(screen.getByRole('button', { name: 'Revoke Research agent' }))
      expect(await screen.findByText(/cannot sign for the account/i)).toBeInTheDocument()
      // #3812: the budget half's way out is offered in the confirm itself, and
      // the copy names the choice instead of sending the owner elsewhere.
      expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeInTheDocument()
      expect(screen.getByText(/Connect your account owner wallet below to end the budget too, or revoke now/)).toBeInTheDocument()
      // Not disabled: the credential half needs no signature.
      const confirm = screen.getByRole('button', { name: /^revoke agent$/i })
      expect(confirm).not.toBeDisabled()
      await userEvent.click(confirm)

      await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith('agt_old'))
      expect(mockRevokeAll).not.toHaveBeenCalled()
      expect(await screen.findByRole('alert')).toHaveTextContent(/budget is still active/i)
      expect(screen.getByRole('button', { name: 'Finish revoking Research agent' })).toBeInTheDocument()
    })

    it('while the signer set is still loading, the confirm waits and does not claim the device cannot sign', async () => {
      mockBudgetHook.ready = false
      mockBudgetHook.signersLoading = true
      render(<SupersededAgentsCard supersededAgentIds={['agt_old']} />)

      await userEvent.click(screen.getByRole('button', { name: 'Revoke Research agent' }))
      expect(screen.queryByText(/cannot sign for the account/i)).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Connect wallet' })).not.toBeInTheDocument()
      // Only the confirm waits; cancel stays usable so the owner is never trapped.
      expect(screen.getByRole('button', { name: /^revoke agent$/i })).toBeDisabled()
      expect(screen.getByRole('button', { name: /keep it/i })).not.toBeDisabled()
      expect(mockRevoke).not.toHaveBeenCalled()
    })

    it('too many budgets points to the budget card instead of offering a retry that cannot work', async () => {
      mockRevokeAll.mockResolvedValue({ ok: false, reason: 'too_many' })
      render(<SupersededAgentsCard supersededAgentIds={['agt_old']} />)

      await userEvent.click(await openConfirm())

      expect(await screen.findByRole('alert')).toHaveTextContent(/too many budgets/i)
      const link = screen.getByRole('link', { name: /budget card/i })
      expect(link).toHaveAttribute('href', '/agents/agt_old')
      expect(screen.queryByRole('button', { name: /finish revoking/i })).not.toBeInTheDocument()
    })

    it('a failed credential revoke never reaches the budget step', async () => {
      mockRevoke.mockRejectedValue(new Error('Agent not found'))
      render(<SupersededAgentsCard supersededAgentIds={['agt_old']} />)

      await userEvent.click(await openConfirm())

      expect(await screen.findByRole('alert')).toHaveTextContent('Agent not found')
      expect(mockRevokeAll).not.toHaveBeenCalled()
    })

    it('Finish revoking retries just the budget, and clears the row on success', async () => {
      mockRevokeAll.mockResolvedValueOnce({ ok: false, reason: 'cancelled' })
      render(<SupersededAgentsCard supersededAgentIds={['agt_old']} />)
      await userEvent.click(await openConfirm())
      await userEvent.click(
        await screen.findByRole('button', { name: 'Finish revoking Research agent' }),
      )

      mockRevokeAll.mockResolvedValueOnce({ ok: true })
      await userEvent.click(await screen.findByRole('button', { name: 'Finish revoking' }))

      await waitFor(() => expect(mockMarkBudgetEnded).toHaveBeenCalledWith('agt_old'))
      expect(mockRevokeAll).toHaveBeenCalledTimes(2)
      // The credential was revoked once, not again.
      expect(mockRevoke).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(screen.queryByText('Research agent')).not.toBeInTheDocument())
    })

    it('an agent with no linked account: revokes the credential, says Haven cannot end the budget, no signing', async () => {
      mockAgents.current = [
        { id: 'agt_old', name: 'Research agent', status: 'active', account_id: null, account_chain_id: null },
      ]
      render(<SupersededAgentsCard supersededAgentIds={['agt_old']} />)

      await userEvent.click(screen.getByRole('button', { name: 'Revoke Research agent' }))
      await userEvent.click(await screen.findByRole('button', { name: /^revoke agent$/i }))

      expect(await screen.findByRole('alert')).toHaveTextContent(/cannot end it from here/i)
      expect(mockRevokeAll).not.toHaveBeenCalled()
      expect(mockBudgetCalls).toEqual([])
      expect(screen.queryByRole('button', { name: /finish revoking/i })).not.toBeInTheDocument()
    })
  })
})
