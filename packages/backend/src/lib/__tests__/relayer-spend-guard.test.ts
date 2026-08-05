import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))

const {
  assertRelayerBudget,
  recordRelayerSpend,
  RelayerBudgetExceededError,
} = await import('../relayer-spend-guard.js')

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
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: '12' }] })
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
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: '11' }] })
    // Default cap 12 applies: 11 < 12 → allowed. A '0' that disabled the
    // guard would also allow — the distinguishing case is below.
    await assertRelayerBudget('sweep', { agentId: 'agent-1' })
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: '12' }] })
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

describe('recordRelayerSpend (#717)', () => {
  beforeEach(() => mockQuery.mockReset())

  it('records the receipt numbers and the derived cost', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    await recordRelayerSpend({
      operation: 'safe_deploy',
      chainId: 84532,
      userId: 'user-1',
      txHash: '0xabc',
      gasUsed: 100_000n,
      effectiveGasPrice: 2_000_000_000n,
    })
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(params).toEqual([
      84532, 'safe_deploy', null, 'user-1', '0xabc',
      '100000', '2000000000', (100_000n * 2_000_000_000n).toString(),
    ])
  })

  it('never throws — a metrics failure must not fail the payment', async () => {
    mockQuery.mockRejectedValueOnce(new Error('insert failed'))
    await recordRelayerSpend({ operation: 'sweep', chainId: 84532, agentId: 'a' })
  })
})
