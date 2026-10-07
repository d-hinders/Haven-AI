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
// #3731: the holdings read goes through the #994 ChainClient port (same as
// balance-coverage.ts). Mocked at the factory so the test never touches a
// provider; the stub records calls to assert ONE balanceOf per DISTINCT token.
const mockGetTokenBalance = vi.fn()
vi.mock('../../../infra/chain/index.js', () => ({
  getChainClient: () => ({ getTokenBalance: mockGetTokenBalance }),
}))
// #2307: a `vi.mock('../../../infra/repositories/agents.js')` stood here
// declaring `listAllowanceConfigForAgent`. #2020 deleted that function, and
// `../allowances.js` does not import the agents repository at all — so the mock
// replaced a module this unit never loads with a function that no longer
// exists. Removed. (Found by `testing/__tests__/mock-factory-exports.guard`,
// not by the #2307 census, which only looked for five of the retired rail's
// export names.)

const { handleGetAllowances } = await import('../allowances.js')

const AGENT = {
  id: 'agt_1',
  execution_rail: 'delegation',
  account_address: '0xsafe',
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
  const res = (await handleGetAllowances(AGENT)) as unknown as {
    body: { allowances: Array<{ onchain: Record<string, string>; funds_cover_remaining?: boolean | null }> }
  }
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

describe('funds_cover_remaining — whether the balance backs each remaining budget (#3731)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDerive.mockResolvedValue(new Map([['agt_1', [budget()]]]))
    mockJson.mockResolvedValue(new Map([['del_1', '{"signed":"delegation"}']]))
    mockRead.mockResolvedValue({ remainingAtomic: '1500000', fromChain: true })
  })

  it('balance ≥ remaining → true', async () => {
    mockGetTokenBalance.mockResolvedValue(2_000_000n)

    const [a] = await onchainOf()
    expect(a.funds_cover_remaining).toBe(true)
  })

  it('balance < remaining → false', async () => {
    mockGetTokenBalance.mockResolvedValue(1_499_999n)

    const [a] = await onchainOf()
    expect(a.funds_cover_remaining).toBe(false)
  })

  it('a failed balanceOf → null — the rest of the response still succeeds', async () => {
    mockGetTokenBalance.mockRejectedValue(new Error('RPC unreachable'))

    const [a] = await onchainOf()
    expect(a.funds_cover_remaining).toBeNull()
    expect(a.onchain.remaining).toBe('1500000')
  })

  it('a non-live remaining (the #1145 fallback) → null, and NO balanceOf is made for it', async () => {
    mockRead.mockResolvedValue({ remainingAtomic: '5000000', fromChain: false })

    const [a] = await onchainOf()
    expect(a.funds_cover_remaining).toBeNull()
    expect(mockGetTokenBalance).not.toHaveBeenCalled()
  })

  it('a remaining of 0 → the key is ABSENT (balance ≥ 0 would be a vacuous true)', async () => {
    mockRead.mockResolvedValue({ remainingAtomic: '0', fromChain: true })
    mockGetTokenBalance.mockResolvedValue(0n)

    const [a] = await onchainOf()
    expect(a.onchain.remaining).toBe('0')
    expect(a).not.toHaveProperty('funds_cover_remaining')
    // No read is spent on a vacuous comparison either.
    expect(mockGetTokenBalance).not.toHaveBeenCalled()
  })

  it('ONE balanceOf per DISTINCT token — two rows on one token share the read, each compared ALONE', async () => {
    // Open + pinned rows on the SAME token (#3518): same balance, different
    // remainings — the balance brackets between them. Two `true` rows would
    // NOT mean both are backed at once; each row is compared alone.
    mockDerive.mockResolvedValue(
      new Map([
        ['agt_1', [budget({ id: 'del_1', token_address: '0xtoken' }), budget({ id: 'del_2', token_address: '0xTOKEN', budget_atomic: '9000000' })]],
      ]),
    )
    mockJson.mockResolvedValue(
      new Map([
        ['del_1', '{"signed":"delegation"}'],
        ['del_2', '{"signed":"delegation"}'],
      ]),
    )
    mockRead.mockImplementation(async (_chain, _json, fallback) => ({ remainingAtomic: fallback, fromChain: true }))
    mockGetTokenBalance.mockResolvedValue(5_500_000n)

    const rows = await onchainOf()
    expect(rows).toHaveLength(2)
    // Distinct-token dedupe: `0xTOKEN` lower-cases onto the same read (the
    // last row's casing wins — the same token either way).
    expect(mockGetTokenBalance).toHaveBeenCalledTimes(1)
    expect(mockGetTokenBalance).toHaveBeenCalledWith(84532, '0xTOKEN', '0xsafe')
    expect(rows[0].funds_cover_remaining).toBe(true) // 5_500_000 ≥ 5_000_000
    expect(rows[1].funds_cover_remaining).toBe(false) // 5_500_000 < 9_000_000
  })

  it('two DISTINCT tokens get one read each, and one failure does not touch the other row', async () => {
    mockDerive.mockResolvedValue(
      new Map([
        ['agt_1', [budget({ id: 'del_1', token_address: '0xtoken' }), budget({ id: 'del_2', token_address: '0xother' })]],
      ]),
    )
    mockJson.mockResolvedValue(
      new Map([
        ['del_1', '{"signed":"delegation"}'],
        ['del_2', '{"signed":"delegation"}'],
      ]),
    )
    mockRead.mockImplementation(async (_chain, _json, fallback) => ({ remainingAtomic: fallback, fromChain: true }))
    mockGetTokenBalance.mockImplementation(async (_chain, token) => {
      if (token === '0xtoken') return 6_000_000n
      throw new Error('RPC unreachable')
    })

    const rows = await onchainOf()
    expect(mockGetTokenBalance).toHaveBeenCalledTimes(2)
    expect(rows[0].funds_cover_remaining).toBe(true)
    expect(rows[1].funds_cover_remaining).toBeNull()
  })
})
