import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import x402Routes from '../x402.js'
import { allowanceModuleRailRetired } from '../../rails/execution-rail.js'

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

// #718 gave the allowance-nonce coordinator a shared Postgres watermark, so it
// now issues one lookup per authorize. These suites mock `db.query` with
// POSITIONAL chains, which any new query shifts (the #775 failure mode). Stub
// the watermark repository instead: it is fail-open and orthogonal to what
// these tests assert, so silencing it changes nothing they measure.
vi.mock('../../infra/repositories/allowance-nonce-watermarks.js', () => ({
  findAllowanceNonceWatermark: async () => null,
  raiseAllowanceNonceWatermark: async () => {},
}))
vi.mock('../../db.js', () => ({ default: { query: (...args: unknown[]) => mockQuery(...args) } }))
vi.mock('../../rails/allowance-module.js', () => allowanceMocks)
vi.mock('../../infra/fiat-values.js', () => fiatMocks)
// Evidence recording moved into the mpp module's public entry point (#997);
// the x402 legacy-rail orchestration imports it from there now.
vi.mock('../../modules/mpp/index.js', () => evidenceMocks)

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

// #1986: the unified approval-row column contract and its ordered-column
// helper (`APPROVAL_COLUMNS` / `approvalInsertColumns`) pinned the shared
// writer's INSERT shape. That writer is never reached on the retired rail
// (every case below is fail-closed at 410 before any INSERT), so both are
// dead weight now — removed rather than left unused.

// #1986 (epic #1440 slice 3): `AGENT` here carries no `execution_rail`,
// which resolves through the LEFT-JOIN `null` fall-through to
// `retired_allowance` — the legacy Safe/AllowanceModule rail these cases
// characterized is retired. Both helper flows below (`queueOverAllowance`
// and `executeWithinAllowance`) now get refused fail-closed with HTTP 410
// right after auth, before any of the approval/intent writer contract they
// were built to pin ever runs. Converted in place rather than deleted, per
// #1986; `modules/x402/legacy-authorize.ts` and these cases are scheduled
// for deletion in #1987.
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
    // #1986: the shared approval-row writer this pinned never runs on the
    // retired rail — fail-closed refuses the account before the over-budget
    // approval-queue path is reached, so no approval_requests INSERT is
    // ever issued to have a column contract at all.
    const response = await queueOverAllowance()
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)

    const insertCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && /INSERT INTO approval_requests/i.test(c[0] as string),
    )
    expect(insertCall, 'no approval_requests INSERT is issued on the retired rail').toBeUndefined()
  })

  it('writes a semantically-x402 row through the shared superset (challenge null)', async () => {
    // #1986: the semantic row this pinned (source/payment_rail/x402_resource_url
    // /machine_challenge_id) is never written on the retired rail — fail-closed
    // refuses the account before the shared writer runs at all.
    const response = await queueOverAllowance()
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
    const insertCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && /INSERT INTO approval_requests/i.test(c[0] as string),
    )
    expect(insertCall, 'no approval_requests INSERT is issued on the retired rail').toBeUndefined()
  })

  it('routes on the delegate balance (balance-aware coverage, unlike the lib core)', async () => {
    // #1986: the balance-aware coverage decision this pinned never runs —
    // fail-closed refuses the account before any coverage decision, so the
    // delegate balance is never read at all on the retired rail.
    const response = await queueOverAllowance()
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
    expect(allowanceMocks.getTokenBalance).not.toHaveBeenCalled()
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
        rows: [{ id: 'intent-1', expires_at: new Date('2026-05-10T20:00:00.000Z'), amount_raw: '20000' }],
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
    // #1986: the shared-writer dedup arbiter this pinned (ON CONFLICT on
    // x402_idempotency_key, both idempotency-key columns filled, challenge
    // null) is never exercised on the retired rail — fail-closed refuses the
    // account before the execute-within-allowance branch, or any
    // payment_intents write, is ever reached.
    const response = await executeWithinAllowance()
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)

    const insertCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && /INSERT INTO payment_intents/i.test(c[0] as string),
    )
    expect(insertCall, 'no payment_intents INSERT is issued on the retired rail').toBeUndefined()
  })
})
