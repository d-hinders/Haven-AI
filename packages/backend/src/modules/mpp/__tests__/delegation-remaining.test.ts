/**
 * `GET /machine-payments/allowances` on the delegation rail reports what the
 * CHAIN will allow, not the full period budget (#1145).
 *
 * Before this, a mid-period exhausted agent read as fully funded, derived
 * `readiness: 'ready'`, and could loop payment attempts that revert on-chain.
 * No funds were ever at risk — the caveat enforcer gates every redemption —
 * but the guidance was wrong.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockDerive = vi.fn()
const mockJson = vi.fn()
const mockRead = vi.fn()

vi.mock('../../../rails/delegation-budget-view.js', () => ({
  deriveDelegationBudgets: (...a: unknown[]) => mockDerive(...a),
}))
vi.mock('../../../infra/repositories/delegation-budgets.js', () => ({
  listDelegationJsonByIds: (...a: unknown[]) => mockJson(...a),
}))
vi.mock('../../../infra/chain/delegation-budget-reader.js', () => ({
  readRemainingBudget: (...a: unknown[]) => mockRead(...a),
}))
vi.mock('../../../rails/execution-rail.js', () => ({
  resolveExecutionRail: () => 'delegation',
  sessionRailRetired: () => ({ statusCode: 410, body: {} }),
}))
// #2307: a `vi.mock('../../../infra/repositories/agents.js')` stood here
// declaring `listAllowanceConfigForAgent`. #2020 deleted that function, and
// `../allowances.js` does not import the agents repository at all — so the mock
// replaced a module this unit never loads with a function that no longer
// exists. Removed. (Found by `testing/__tests__/mock-factory-exports.guard`,
// not by the #2307 census, which only looked for five allowance-module names.)

const { handleGetAllowances } = await import('../allowances.js')

const AGENT = {
  id: 'agt_1',
  execution_rail: 'delegation',
  safe_address: '0xsafe',
  delegate_address: '0xdelegate',
  chain_id: 84532,
} as never

const budget = (over: Record<string, unknown> = {}) => ({
  id: 'del_1',
  agent_id: 'agt_1',
  chain_id: 84532,
  token_address: '0xtoken',
  token_symbol: 'USDC',
  allowance_amount: '5.00',
  reset_period_min: 1440,
  budget_atomic: '5000000',
  period_seconds: 86_400,
  ...over,
})

const onchainOf = async () => {
  const res = (await handleGetAllowances(AGENT)) as unknown as { body: { allowances: Array<{ onchain: Record<string, string> }> } }
  return res.body.allowances
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDerive.mockResolvedValue(new Map([['agt_1', [budget()]]]))
  mockJson.mockResolvedValue(new Map([['del_1', '{"signed":"delegation"}']]))
})

describe('delegation-rail remaining reflects in-period spend (#1145)', () => {
  it('reports the enforcer-reported remainder, and derives spent from it', async () => {
    mockRead.mockResolvedValue({ remainingAtomic: '1500000', fromChain: true })

    const [a] = await onchainOf()
    expect(a.onchain.remaining).toBe('1500000')
    // Derived, not tracked: budget − remaining. A separate tally would be a
    // second source that can only drift from the enforcer.
    expect(a.onchain.spent).toBe('3500000')
    expect(a.onchain.effective_spent).toBe('3500000')
    expect(a.onchain.amount).toBe('5000000') // the budget it re-arms to
    // #1319: a live read's provenance is on the wire too.
    expect(a.onchain.remaining_is_from_chain).toBe(true)
  })

  it('an EXHAUSTED period reports zero — the bug this closes', async () => {
    // The old code answered '5000000' here, so readiness derived 'ready' and
    // the agent looped attempts that revert on-chain.
    mockRead.mockResolvedValue({ remainingAtomic: '0', fromChain: true })

    const [a] = await onchainOf()
    expect(a.onchain.remaining).toBe('0')
    expect(a.onchain.spent).toBe('5000000')
  })

  it('falls back to the FULL BUDGET when the chain read fails — never to zero', async () => {
    // Reporting 0 on a transient RPC problem would tell a funded agent it
    // cannot pay. The fallback is the pre-#1145 answer: no worse than before.
    mockRead.mockResolvedValue({ remainingAtomic: '5000000', fromChain: false })

    const [a] = await onchainOf()
    expect(a.onchain.remaining).toBe('5000000')
    expect(a.onchain.spent).toBe('0')
    // #1319: the fallback is fund-safe and UNCHANGED by this issue — but the
    // provenance is now visible on the wire, so a caller can tell an
    // optimistic figure from a confirmed one.
    expect(a.onchain.remaining_is_from_chain).toBe(false)
  })

  it('#1319: the no-delegation-json branch is ALSO the fallback — same provenance as an RPC failure', async () => {
    // No `del_1` row in the json map at all (distinct fixture from the
    // RPC-failure case above): readRemainingBudget is never even reached,
    // but the caller-visible provenance must read identically either way —
    // both are "not a live read".
    mockJson.mockResolvedValue(new Map())

    const [a] = await onchainOf()
    expect(a.onchain.remaining).toBe('5000000') // budget_atomic, the fallback
    expect(mockRead).not.toHaveBeenCalled()
    expect(a.onchain.remaining_is_from_chain).toBe(false)
  })

  it('clamps spent at zero when the budget was lowered mid-period', async () => {
    // The enforcer can report more remaining than a freshly-lowered budget,
    // which would make a naive subtraction negative.
    mockRead.mockResolvedValue({ remainingAtomic: '9000000', fromChain: true })

    const [a] = await onchainOf()
    expect(a.onchain.spent).toBe('0')
    expect(a.onchain.remaining).toBe('9000000')
  })

  it('scopes to the agent chain — a delegation on another chain is not reported under it', async () => {
    // The response carries ONE top-level chain_id; a foreign-chain delegation
    // listed under it is a straightforwardly wrong number.
    mockDerive.mockResolvedValue(
      new Map([['agt_1', [budget(), budget({ id: 'del_other', chain_id: 8453 })]]]),
    )
    mockRead.mockResolvedValue({ remainingAtomic: '1000000', fromChain: true })

    const rows = await onchainOf()
    expect(rows).toHaveLength(1)
    expect(mockJson).toHaveBeenCalledWith(['del_1'])
  })

  it('never asks the chain when there is no active delegation', async () => {
    mockDerive.mockResolvedValue(new Map())

    expect(await onchainOf()).toEqual([])
    expect(mockRead).not.toHaveBeenCalled()
  })
})
