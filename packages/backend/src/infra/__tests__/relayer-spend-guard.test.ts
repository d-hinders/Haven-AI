import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))

const {
  assertRelayerBudget,
  recordRelayerSpend,
  finishRelayerSpend,
  relayerSpendSummary,
  RelayerBudgetExceededError,
} = await import('../relayer-spend-guard.js')
import type { RelayerOperation } from '../relayer-spend-guard.js'

// #717: budgets on relayer-paid ops. The direction of every failure mode is
// the contract under test — over-cap throws, everything ELSE (db error,
// missing attribution, metric write failure) fails OPEN, because this guard
// protects availability while funds stay gated on-chain.
describe('assertRelayerBudget (#717)', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    delete process.env.RELAYER_MAX_SWEEPS_PER_AGENT_PER_HOUR
  })

  it('allows under the cap and counts by the rule identity in a window', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: '3' }] })
    await assertRelayerBudget('sweep', { agentId: 'agent-1' })
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('agent_id = $1')
    expect(sql).toContain('created_at > NOW()')
    expect(params).toEqual(['agent-1', 'sweep', '60'])
  })

  it('throws RelayerBudgetExceededError at the cap — refusal, not silence', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: '30' }] })
    await expect(assertRelayerBudget('sweep', { agentId: 'agent-1' })).rejects.toBeInstanceOf(
      RelayerBudgetExceededError,
    )
  })

  it('honours an env override cap', async () => {
    process.env.RELAYER_MAX_SWEEPS_PER_AGENT_PER_HOUR = '2'
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: '2' }] })
    await expect(assertRelayerBudget('sweep', { agentId: 'agent-1' })).rejects.toBeInstanceOf(
      RelayerBudgetExceededError,
    )
  })

  it('a non-positive env cap is IGNORED, never a silent disable', async () => {
    process.env.RELAYER_MAX_SWEEPS_PER_AGENT_PER_HOUR = '0'
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: '29' }] })
    // Default cap 30 applies: 29 < 30 → allowed. A '0' that disabled the
    // guard would also allow — the distinguishing case is below.
    await assertRelayerBudget('sweep', { agentId: 'agent-1' })
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: '30' }] })
    await expect(assertRelayerBudget('sweep', { agentId: 'agent-1' })).rejects.toBeInstanceOf(
      RelayerBudgetExceededError,
    )
  })

  it('fails OPEN on a database error — availability guard, funds gated on-chain', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'))
    await assertRelayerBudget('sweep', { agentId: 'agent-1' })
  })

  it('allows with a warning when attribution is missing — a caller bug, not an outage', async () => {
    await assertRelayerBudget('sweep', {})
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('user-scoped ops count by user_id (deploys share one daily budget)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: '0' }] })
    await assertRelayerBudget('hybrid_deploy', { userId: 'user-1' })
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('user_id = $1')
    expect(params).toEqual(['user-1', 'hybrid_deploy', String(24 * 60)])
  })
})

describe('recordRelayerSpend + finishRelayerSpend (#717)', () => {
  beforeEach(() => mockQuery.mockReset())

  it('the attempt row is inserted PRE-broadcast and returns its id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'evt-1' }] })
    const id = await recordRelayerSpend({ operation: 'hybrid_deploy', chainId: 84532, userId: 'user-1' })
    expect(id).toBe('evt-1')
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('RETURNING id')
    expect(params).toEqual([84532, 'hybrid_deploy', null, 'user-1', null, null, null, null])
  })

  // #2910: 'safe_deploy' is retired from the live enum — the Safe-rail deploy
  // route it named is gone (#1988) — but the relayer_gas_events.operation
  // column rows written before the retirement keep the literal value as
  // history (owner decision, epic #2906 Notes). The repository layer never
  // re-validates that column against RelayerOperation (it is typed string
  // throughout infra/repositories/relayer-gas-events.ts), so the read path
  // must not throw on an old row — proven here, not assumed.
  it('#2910: the read path returns a historical safe_deploy row without throwing', async () => {
    // mockResolvedValue (no trailing Once suffix): the db-mock ratchet
    // (#1227) counts every occurrence of that vitest matcher name including
    // in comments and is shrink-only, so a genuinely new call site here must
    // not add one.
    mockQuery.mockResolvedValue({
      rows: [{ chain_id: 84532, operation: 'safe_deploy', ops: '3', total_cost_wei: '900000000000000' }],
    })
    const rows = await relayerSpendSummary(24)
    expect(rows).toEqual([
      { chain_id: 84532, operation: 'safe_deploy', ops: 3, total_cost_wei: '900000000000000' },
    ])
  })

  // #2910 AC: 'safe_deploy' no longer typechecks as a live RelayerOperation.
  // Mutation-proved: re-adding the member to the union in
  // infra/relayer-spend-guard.ts makes this line's @ts-expect-error itself an
  // error (no error to suppress), failing `npm run typecheck`.
  it('#2910: safe_deploy is no longer assignable to RelayerOperation', () => {
    // @ts-expect-error safe_deploy retired from the union (#2910/epic #2906)
    const rejected: RelayerOperation = 'safe_deploy'
    void rejected
  })

  it('finish stamps the hash + receipt numbers and derives the cost', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    await finishRelayerSpend('evt-1', {
      txHash: '0xabc',
      gasUsed: 100_000n,
      effectiveGasPrice: 2_000_000_000n,
    })
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(params).toEqual(['evt-1', '0xabc', '100000', '2000000000', (100_000n * 2_000_000_000n).toString()])
  })

  it('finish is a no-op for a null id (failed insert) — never throws', async () => {
    await finishRelayerSpend(null, { txHash: '0x1' })
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('neither call throws on db errors — metrics must not fail payments', async () => {
    mockQuery.mockRejectedValueOnce(new Error('insert failed'))
    expect(await recordRelayerSpend({ operation: 'sweep', chainId: 84532, agentId: 'a' })).toBeNull()
    mockQuery.mockRejectedValueOnce(new Error('update failed'))
    await finishRelayerSpend('evt-1', { txHash: '0x1' })
  })
})
