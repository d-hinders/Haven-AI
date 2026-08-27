/**
 * `useDelegationCustodyProof` — the read half of the delegation-rail custody
 * proof (#2106).
 *
 * This file exists because of a mutation that killed NOTHING. The page tests
 * mock this hook wholesale, so they prove the CARD renders honestly when it is
 * handed `budgetsError: true` — and prove nothing at all about whether the hook
 * ever sets it. Reverting the hook's error handling left all 25 of them green.
 *
 * So the contract under test here is specifically the part a mocked hook can
 * never cover: a failed read must be distinguishable from an empty one. On the
 * page whose job is refusing to make custody claims Haven cannot back, "we
 * could not read this" collapsing into "there is nothing here" is the whole
 * defect class.
 */

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { get: mockGet } }))

import { useDelegationCustodyProof } from '@/hooks/useDelegationCustodyProof'

const ACCOUNT = '0x1111111111111111111111111111111111111111'
const CHAIN_ID = 84532

const SIGNERS = {
  account_address: ACCOUNT,
  chain_id: CHAIN_ID,
  owner_address: null,
  passkeys: [{ key_id: `0x${'11'.repeat(32)}`, x: '0x1', y: '0x2', created_at: null }],
}

function budget(hash: string) {
  return {
    id: `dlg-${hash}`,
    token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    recipient_address: null,
    delegation_hash: hash,
    version: 1,
    status: 'active' as const,
    budget_atomic: '250000000',
    period_seconds: 604_800,
    expires_at: 2_000_000_000,
  }
}

/** Route the fake API by path so each test states only what it cares about. */
function route(handlers: { signers?: () => unknown; delegations?: (id: string) => unknown }) {
  mockGet.mockImplementation(async (path: string) => {
    if (path.includes('/signers')) {
      if (!handlers.signers) throw new Error('unrouted signers read')
      return handlers.signers()
    }
    const m = /\/agents\/([^/]+)\/delegations/.exec(path)
    if (m) {
      if (!handlers.delegations) throw new Error('unrouted delegations read')
      return handlers.delegations(m[1])
    }
    throw new Error(`unexpected path ${path}`)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useDelegationCustodyProof — a failed delegation read (#2106)', () => {
  it('flags budgetsError when an agent read rejects', async () => {
    route({
      signers: () => SIGNERS,
      delegations: () => {
        throw new Error('network')
      },
    })
    const { result } = renderHook(() => useDelegationCustodyProof(ACCOUNT, CHAIN_ID, ['agent-1']))
    await waitFor(() => expect(result.current.budgetsLoading).toBe(false))
    expect(result.current.budgetsError).toBe(true)
  })

  it('leaves the failed agent ABSENT rather than storing an empty list', async () => {
    // The load-bearing assertion. An empty array is a claim ("this agent has
    // no delegation"); absence is the honest unknown the card branches on.
    route({
      signers: () => SIGNERS,
      delegations: () => {
        throw new Error('network')
      },
    })
    const { result } = renderHook(() => useDelegationCustodyProof(ACCOUNT, CHAIN_ID, ['agent-1']))
    await waitFor(() => expect(result.current.budgetsLoading).toBe(false))
    expect(result.current.budgetsByAgent.has('agent-1')).toBe(false)
  })

  it('keeps the agents that DID load when one of several fails', async () => {
    route({
      signers: () => SIGNERS,
      delegations: (id) => {
        if (id === 'agent-bad') throw new Error('network')
        return { delegations: [budget(`0x${'4d'.repeat(32)}`)] }
      },
    })
    const { result } = renderHook(() =>
      useDelegationCustodyProof(ACCOUNT, CHAIN_ID, ['agent-ok', 'agent-bad']),
    )
    await waitFor(() => expect(result.current.budgetsLoading).toBe(false))
    expect(result.current.budgetsByAgent.get('agent-ok')).toHaveLength(1)
    expect(result.current.budgetsByAgent.has('agent-bad')).toBe(false)
    expect(result.current.budgetsError).toBe(true)
  })

  it('does NOT flag an error when every read succeeds and returns nothing', async () => {
    // The other direction: a genuinely empty account must stay distinguishable
    // from a broken read, or the flag would make every account "unknown".
    route({ signers: () => SIGNERS, delegations: () => ({ delegations: [] }) })
    const { result } = renderHook(() => useDelegationCustodyProof(ACCOUNT, CHAIN_ID, ['agent-1']))
    await waitFor(() => expect(result.current.budgetsLoading).toBe(false))
    expect(result.current.budgetsError).toBe(false)
    expect(result.current.budgetsByAgent.get('agent-1')).toEqual([])
  })

  it('clears a previous error once a retry succeeds', async () => {
    let fail = true
    route({
      signers: () => SIGNERS,
      delegations: () => {
        if (fail) throw new Error('network')
        return { delegations: [budget(`0x${'5e'.repeat(32)}`)] }
      },
    })
    const { result } = renderHook(() => useDelegationCustodyProof(ACCOUNT, CHAIN_ID, ['agent-1']))
    await waitFor(() => expect(result.current.budgetsError).toBe(true))
    fail = false
    await result.current.reloadBudgets()
    await waitFor(() => expect(result.current.budgetsError).toBe(false))
    expect(result.current.budgetsByAgent.get('agent-1')).toHaveLength(1)
  })
})

describe('useDelegationCustodyProof — signer read (#2106)', () => {
  it('renders no signer set rather than a wrong one when the read fails', async () => {
    route({
      signers: () => {
        throw new Error('network')
      },
      delegations: () => ({ delegations: [] }),
    })
    const { result } = renderHook(() => useDelegationCustodyProof(ACCOUNT, CHAIN_ID, ['agent-1']))
    await waitFor(() => expect(result.current.signersLoading).toBe(false))
    expect(result.current.signers).toBeNull()
  })

  it('does not fetch anything for an account with no address', async () => {
    route({ signers: () => SIGNERS, delegations: () => ({ delegations: [] }) })
    const { result } = renderHook(() => useDelegationCustodyProof(null, CHAIN_ID, []))
    await waitFor(() => expect(result.current.signersLoading).toBe(false))
    expect(result.current.signers).toBeNull()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('does not loop: a stable agent list fetches each agent once', async () => {
    // `agentIds` is a fresh array every render; the effect keys off a joined
    // string so it must not refire. A regression here is a request storm.
    route({ signers: () => SIGNERS, delegations: () => ({ delegations: [] }) })
    const { rerender, result } = renderHook(
      ({ ids }: { ids: string[] }) => useDelegationCustodyProof(ACCOUNT, CHAIN_ID, ids),
      { initialProps: { ids: ['agent-1'] } },
    )
    await waitFor(() => expect(result.current.budgetsLoading).toBe(false))
    rerender({ ids: ['agent-1'] })
    rerender({ ids: ['agent-1'] })
    await waitFor(() => expect(result.current.budgetsLoading).toBe(false))
    const delegationCalls = mockGet.mock.calls.filter((c) => String(c[0]).includes('/delegations'))
    expect(delegationCalls).toHaveLength(1)
  })
})
