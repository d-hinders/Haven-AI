import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import x402Routes from '../x402.js'

/**
 * Characterization scaffolding for the x402 / machine-payment consolidation
 * (PT-1 — see docs/contributing/x402-mpp-consolidation.md).
 *
 * The two payment paths implement the same policy-first decision separately.
 * Before routing /x402 onto the shared `authorizeMachinePayment` core, this pins
 * the two things the extraction must reconcile and could silently change:
 *
 *  1. The exact, ORDERED approval-row column contract the x402 over-allowance
 *     path emits. As of PR2 this is the SHARED superset written by
 *     lib/machine-payments.createMachineApproval (both paths now call it), so the
 *     x402 INSERT now includes `machine_challenge_id` — set to null for x402.
 *     The semantic row is unchanged (an explicit null challenge == the old
 *     omitted column), which these tests pin: source/payment_rail stay 'x402',
 *     x402_resource_url is set, and the challenge value is null.
 *  2. That the x402 coverage decision is BALANCE-AWARE (consults the delegate
 *     balance), unlike the allowance-only lib core. The unified core must keep
 *     this as a parameterized strategy, not erase it.
 *
 * This is refactor scaffolding, not a permanent correctness guard: once PR4
 * routes /x402 onto authorizeMachinePayment and PR3 extracts the coverage
 * decision into an oracle-grounded loop, fold these assertions into those and
 * delete this file.
 */

const { mockQuery, allowanceMocks, fiatMocks, evidenceMocks } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  allowanceMocks: {
    getTokenAllowance: vi.fn(),
    getTokenBalance: vi.fn(),
    getLatestBlockTimeSec: vi.fn(),
    computeEffectiveAllowance: vi.fn(),
    generateTransferHash: vi.fn(),
    recoverSigner: vi.fn(),
    executeAllowanceTransfer: vi.fn(),
  },
  fiatMocks: { getFiatValuesForTokenAmount: vi.fn() },
  evidenceMocks: { tryRecordMachinePaymentEvidenceBaseById: vi.fn() },
}))

vi.mock('../../db.js', () => ({ default: { query: (...args: unknown[]) => mockQuery(...args) } }))
vi.mock('../../lib/allowance-module.js', () => allowanceMocks)
vi.mock('../../lib/fiat-values.js', () => fiatMocks)
vi.mock('../../lib/machine-payment-evidence.js', () => evidenceMocks)

const AGENT = {
  id: '11111111-1111-1111-1111-111111111111',
  user_id: '22222222-2222-2222-2222-222222222222',
  name: 'Payment Agent',
  delegate_address: '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1',
  safe_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
  chain_id: 8453,
  status: 'active',
}
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const MERCHANT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'

// The unified superset contract written by createMachineApproval (PR2), in
// order. x402 now goes through the same writer, so machine_challenge_id is
// present in the column list (the value is null for x402 — pinned below).
const APPROVAL_COLUMNS = [
  'agent_id', 'user_id', 'safe_address', 'chain_id', 'token_symbol', 'token_address',
  'to_address', 'amount_raw', 'amount_human', 'reason', 'source', 'x402_resource_url',
  'payment_rail', 'payment_resource_url', 'merchant_address', 'machine_challenge_id',
  'machine_idempotency_key', 'machine_metadata', 'status', 'expires_at',
]

/** Pull the ordered column list out of an `INSERT INTO approval_requests (...)` statement. */
function approvalInsertColumns(sql: string): string[] {
  const m = sql.match(/INSERT INTO approval_requests\s*\(([^)]*)\)/i)
  if (!m) throw new Error('not an approval_requests insert')
  return m[1].split(',').map((c) => c.trim()).filter(Boolean)
}

describe('x402↔MPP consolidation — characterization (PT-1)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(x402Routes, { prefix: '/x402' })
  })
  afterAll(async () => {
    await app.close()
  })
  beforeEach(() => {
    process.env.X402_BINDING_PRIVATE_KEY =
      '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
    mockQuery.mockReset()
    for (const m of Object.values(allowanceMocks)) m.mockReset()
    for (const m of Object.values(fiatMocks)) m.mockReset()
    for (const m of Object.values(evidenceMocks)) m.mockReset()
    allowanceMocks.getTokenBalance.mockResolvedValue(0n)
  })

  function queueOverAllowance() {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 10_000n })
    // Delegate balance covers the shortfall, so the balance-aware pre-flight
    // passes and we fall into the over-allowance approval-queue branch.
    allowanceMocks.getTokenBalance.mockResolvedValueOnce(20_000n)
    mockQuery
      .mockResolvedValueOnce({ rows: [AGENT] }) // auth
      .mockResolvedValueOnce({ rows: [] }) // existing intent lookup
      .mockResolvedValueOnce({ rows: [] }) // existing approval lookup
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '10' }] }) // db allowance
      .mockResolvedValueOnce({ rows: [{ max_x402_per_hour: 100 }] }) // rate cfg
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] }) // recent count
      .mockResolvedValueOnce({
        rows: [{
          id: 'approval-123', status: 'pending', token_symbol: 'USDC',
          amount_human: '0.02', expires_at: '2026-05-10T20:00:00.000Z',
          machine_challenge_id: null,
        }],
      }) // approval INSERT
    return app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp', payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT, amount: '20000', asset: USDC, network: 'base',
        category: 'data', idempotencyKey: 'x402:approval',
      },
    })
  }

  it('emits the exact ordered shared approval-row column contract', async () => {
    const response = await queueOverAllowance()
    expect(response.statusCode).toBe(202)

    const insertCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && /INSERT INTO approval_requests/i.test(c[0] as string),
    )
    expect(insertCall, 'an approval_requests INSERT was issued').toBeDefined()

    const columns = approvalInsertColumns(insertCall![0] as string)
    expect(columns).toEqual(APPROVAL_COLUMNS)
    expect(insertCall![0]).toContain('ON CONFLICT (agent_id, machine_idempotency_key)')
    expect(insertCall![0]).toContain('DO NOTHING')
  })

  it('writes a semantically-x402 row through the shared superset (challenge null)', async () => {
    // PR2 routed x402 through createMachineApproval, so the column list is now
    // the superset (machine_challenge_id included). Pin that the x402 row is
    // semantically unchanged: source/payment_rail are 'x402', x402_resource_url
    // is set, and the challenge value is null (x402 dedupes on idempotency key).
    const response = await queueOverAllowance()
    expect(response.statusCode).toBe(202)
    const insertCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && /INSERT INTO approval_requests/i.test(c[0] as string),
    )!
    const cols = approvalInsertColumns(insertCall[0] as string)
    const params = insertCall[1] as unknown[]
    // status / expires_at are SQL literals (last two columns), so for every
    // bound column the param index equals the column index.
    const valueOf = (col: string) => params[cols.indexOf(col)]

    expect(cols).toContain('machine_challenge_id')
    expect(valueOf('machine_challenge_id')).toBeNull()
    expect(valueOf('source')).toBe('x402')
    expect(valueOf('payment_rail')).toBe('x402')
    expect(valueOf('x402_resource_url')).toBe('https://mcp.soundside.ai/mcp')
  })

  it('routes on the delegate balance (balance-aware coverage, unlike the lib core)', async () => {
    // The x402 path consults the delegate balance and routes on
    // delegateBalance + remaining; the allowance-only lib core never reads it.
    // Pinning this ensures the consolidation keeps the balance-aware strategy
    // for x402 rather than collapsing onto allowance-only routing.
    await queueOverAllowance()
    expect(allowanceMocks.getTokenBalance).toHaveBeenCalledWith(
      AGENT.chain_id, AGENT.delegate_address, USDC,
    )
  })

  // Drive the within-allowance execute path so the payment_intents INSERT runs.
  function executeWithinAllowance() {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 1_000_000n })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(`0x${'11'.repeat(32)}`)
    mockQuery
      .mockResolvedValueOnce({ rows: [AGENT] }) // auth
      .mockResolvedValueOnce({ rows: [] }) // existing intent lookup
      .mockResolvedValueOnce({ rows: [] }) // existing approval lookup
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '10' }] }) // db allowance
      .mockResolvedValueOnce({ rows: [{ max_x402_per_hour: 100 }] }) // rate cfg
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] }) // recent count
      .mockResolvedValueOnce({
        rows: [{ id: 'intent-1', expires_at: new Date('2026-05-10T20:00:00.000Z') }],
      }) // payment_intents INSERT
    return app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp', payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT, amount: '20000', asset: USDC, network: 'base',
        category: 'data', idempotencyKey: 'x402:exec',
      },
    })
  }

  it('persists the x402 intent through the shared writer, keeping the x402_idempotency_key conflict arbiter', async () => {
    // PR4 routed x402 through createPaymentIntent. The critical preserved
    // behavior is the DEDUP arbiter: x402 must keep ON CONFLICT on
    // x402_idempotency_key (not machine_idempotency_key) — switching it would
    // change which partial-unique index enforces idempotency on the money path.
    // Also pin the semantic equivalence: source/payment_rail 'x402', both
    // idempotency keys filled, challenge null.
    const response = await executeWithinAllowance()
    expect(response.statusCode).toBe(201)

    const insertCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && /INSERT INTO payment_intents/i.test(c[0] as string),
    )
    expect(insertCall, 'a payment_intents INSERT was issued').toBeDefined()
    const sql = insertCall![0] as string
    expect(sql).toContain('ON CONFLICT (agent_id, x402_idempotency_key)')
    expect(sql).not.toContain('ON CONFLICT (agent_id, machine_idempotency_key)')
    // The conflict WHERE predicate must match the partial-unique index
    // (idx_payment_intents_x402_idempotency) or the upsert throws at runtime.
    expect(sql).toMatch(
      /ON CONFLICT \(agent_id, x402_idempotency_key\)\s*WHERE x402_idempotency_key IS NOT NULL\s*AND status NOT IN \('failed', 'expired'\)/,
    )

    // Pin the row's semantic equivalence by column position. `status` (a literal
    // 'pending_signature') and `expires_at` (a NOW()+interval literal) have no
    // bind placeholder, so drop them: the param index is the position among the
    // remaining bound columns.
    const cols = (sql.match(/INSERT INTO payment_intents\s*\(([^)]*)\)/i)![1])
      .split(',').map((c) => c.trim()).filter(Boolean)
    const boundCols = cols.filter((c) => c !== 'status' && c !== 'expires_at')
    const params = insertCall![1] as unknown[]
    const valueOf = (col: string) => params[boundCols.indexOf(col)]

    expect(valueOf('source')).toBe('x402')
    expect(valueOf('payment_rail')).toBe('x402')
    expect(valueOf('machine_challenge_id')).toBeNull()
    // x402 fills BOTH idempotency-key columns with the request key; the dedup
    // arbiter (asserted above) is what distinguishes the rail.
    expect(valueOf('x402_idempotency_key')).toBe('x402:exec')
    expect(valueOf('machine_idempotency_key')).toBe('x402:exec')
  })
})
