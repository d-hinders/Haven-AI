// db-mock-exempt: route-level handler test (status/refusal shape) — DB
// behaviour (the real `agent_task_budgets`/`agent_delegations` reads this
// catch performs) is proven in infra/repositories/__tests__/{task-budgets,
// delegation-budgets}.test.ts on the real-DB harness. This file mirrors
// `non-custody-authz.contract.test.ts`'s pattern-matched DB stub and mocks
// only the collaborators the route does not own (chain reads, the bundler).
/**
 * #3494 — `POST /payments/:id/sign`'s failure catch: a typed `error_code`
 * and cause class on the 502, instead of one untyped "On-chain execution
 * failed" for everything a bundler can throw after the route already
 * claimed the intent. Review rounds 1 and 2 split and extended the classes;
 * in the order the route checks them: `SubmittedUserOpFailedError` with
 * outcome `receipt_unconfirmed` (#3564 — checked FIRST, double-pay risk,
 * B1/B1': the submit MAY have landed, so the row is booked outcome-PENDING,
 * never `failed`, and the 502 says to poll `haven_get_payment_status`), then
 * the route books every KNOWN failure `failed` (`failSubmittedIntent`) and
 * classifies it: AA24 signature rejection, every other AA2x
 * account-validation failure, a task-budget transfer-cap revert, a
 * period-budget revert, and the generic fallback — which also catches
 * `SubmittedUserOpFailedError` with outcome `included_reverted` (round 2,
 * N3: the op executed and reverted is a KNOWN, confirmed outcome, not an
 * unknown one).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockQuery, fiatMocks, delegationMocks, mockReadSpent, mockReadRemaining } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  fiatMocks: {
    getFiatValuesForTokenAmount: vi.fn(),
    getBookTimeCapture: vi.fn().mockResolvedValue(null),
  },
  delegationMocks: {
    selectDelegation: vi.fn(),
    prepareDelegationPayment: vi.fn(),
    submitDelegationPayment: vi.fn(),
  },
  mockReadSpent: vi.fn(),
  mockReadRemaining: vi.fn(),
}))

vi.mock('../../db.js', () => ({ default: { query: (...args: unknown[]) => mockQuery(...args) } }))
vi.mock('../../infra/fiat-values.js', () => fiatMocks)
// Only the network seam of the delegation rail (bundler/EntryPoint/account)
// is mocked — the claim/fail writes below are real production code.
vi.mock('../../rails/delegation-authorization.js', () => delegationMocks)
// #3500's cap check reads the enforcer's own spentMap — no chain here.
vi.mock('../../infra/chain/task-budget-spent-reader.js', () => ({
  readTaskBudgetSpent: (...a: unknown[]) => mockReadSpent(...a),
}))
// #3503's period-budget re-read — no chain here either.
vi.mock('../../infra/chain/delegation-budget-reader.js', () => ({
  readRemainingBudget: (...a: unknown[]) => mockReadRemaining(...a),
}))

import Fastify, { type FastifyInstance } from 'fastify'
import paymentRoutes from '../payments.js'
import { installRequestValidation } from '../../openapi/request-validation.js'
import { serializeUserOp } from '../../rails/execution-rail.js'
import { SubmittedUserOpFailedError } from '../../rails/delegation-rail.js'

const AGENT = {
  id: '11111111-1111-1111-1111-111111111111',
  user_id: '22222222-2222-2222-2222-222222222222',
  name: 'Sign Failure Agent',
  delegate_address: '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1',
  account_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
  chain_id: 84532,
  status: 'active',
  account_type: 'delegator_hybrid',
  execution_rail: 'delegation',
}
const PAYMENT_ID = '33333333-3333-3333-3333-333333333333'
const USEROP_SIGNATURE = `0x${'ab'.repeat(97)}`
const DELEGATION_HASH = `0x${'12'.repeat(32)}`
const BUDGET_DELEGATION_HASH = `0x${'34'.repeat(32)}`
const TASK_BUDGET_ID = '44444444-4444-4444-4444-444444444444'
const TASK_BUDGET_DELEGATION_HASH = `0x${'56'.repeat(32)}`
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const PREPARED_USER_OP = {
  sender: AGENT.account_address,
  nonce: 1n,
  callData: '0xdeadbeef',
}

type DbRoute = [RegExp, (sql: string, params: unknown[]) => { rows: unknown[] } | Promise<{ rows: unknown[] }>]

function primeDb(...routes: DbRoute[]) {
  mockQuery.mockImplementation(async (sql: unknown, params: unknown[]) => {
    const text = String(sql)
    for (const [re, handler] of routes) {
      if (re.test(text)) return handler(text, params)
    }
    return { rows: [] }
  })
}

const AUTH: DbRoute = [/api_key_hash = \$1/, () => ({ rows: [AGENT] })]
const CLAIM_OK: DbRoute = [/SET signature[\s\S]*status = 'submitted'/, () => ({ rows: [{ id: PAYMENT_ID }] })]
const FAIL_WRITE: DbRoute = [/SET status = 'failed'/, () => ({ rows: [] })]

function intentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    agent_id: AGENT.id,
    user_id: AGENT.user_id,
    account_address: AGENT.account_address,
    chain_id: AGENT.chain_id,
    token_symbol: 'USDC',
    token_address: USDC,
    to_address: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
    amount_raw: '100000',
    amount_human: '0.10',
    delegate_address: AGENT.delegate_address,
    allowance_nonce: 0,
    sign_hash: `0x${'11'.repeat(32)}`,
    signature: null,
    status: 'pending_signature',
    expires_at: '2099-01-01T00:00:00.000Z',
    execution_rail: 'delegation',
    delegation_hash: DELEGATION_HASH,
    budget_delegation_hash: null,
    task_budget_id: null,
    prepared_user_op: JSON.parse(serializeUserOp(PREPARED_USER_OP)),
    payment_rail: null,
    source: null,
    x402_resource_url: null,
    payment_resource_url: null,
    ...overrides,
  }
}

const intentById = (row: Record<string, unknown>): DbRoute => [
  /FROM payment_intents\s+WHERE id/,
  () => ({ rows: [row] }),
]

/** ABI-encoded `Error(string)`, the shape a bundler actually relays (#3503). */
function hexRevert(reason: string): string {
  return (
    'UserOperation reverted during simulation with reason: 0x08c379a0' +
    (32).toString(16).padStart(64, '0') +
    reason.length.toString(16).padStart(64, '0') +
    Buffer.from(reason, 'utf8').toString('hex').padEnd(Math.ceil(reason.length / 32) * 64, '0')
  )
}

describe('POST /payments/:id/sign — failure catch classification (#3494)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/payments.ts'] })
    await app.register(paymentRoutes, { prefix: '/payments' })
  })
  afterAll(async () => { await app.close() })
  beforeEach(() => {
    mockQuery.mockReset()
    for (const m of Object.values(fiatMocks)) m.mockReset()
    for (const m of Object.values(delegationMocks)) m.mockReset()
    mockReadSpent.mockReset()
    mockReadRemaining.mockReset()
  })

  async function sign() {
    return app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: USEROP_SIGNATURE },
    })
  }

  it('submission outcome unknown (#3564): the receipt-unconfirmed variant, checked before every other cause — outcome-PENDING, never failed', async () => {
    primeDb(AUTH, intentById(intentRow()), CLAIM_OK, FAIL_WRITE)
    delegationMocks.submitDelegationPayment.mockRejectedValueOnce(
      new SubmittedUserOpFailedError(
        'redemption UserOp 0xabc was sent but its receipt could not be confirmed: timeout',
        '0xabc',
        'receipt_unconfirmed',
      ),
    )

    const res = await sign()

    expect(res.statusCode).toBe(502)
    const body = res.json()
    // #3564: the intent is NOT failed — the submit MAY have landed, so the
    // row stays `submitted` with the userOpHash recorded for the submission
    // reconciler, and the 502 is a poll instruction, not a failure verdict.
    expect(body.status).toBe('submitted')
    expect(body.error_code).toBe('submission_outcome_unknown')
    expect(body.payment_id).toBe(PAYMENT_ID)
    expect(body.user_op_hash).toBe('0xabc')
    expect(body.details).toMatch(/receipt could not be confirmed/)
    // The remedy: do not create a new payment, poll the status read — which
    // is truthful now that the row is outcome-pending, not failed.
    expect(body.error).toMatch(/outcome unknown/i)
    // The booking write issued (machine_metadata gains the user_op_hash),
    // and failSubmittedIntent was NEVER reached — no terminal booking.
    expect(mockQuery.mock.calls.some((c) => /user_op_hash/.test(String(c[0])))).toBe(true)
    expect(mockQuery.mock.calls.some((c) => /SET status = 'failed'/.test(String(c[0])))).toBe(false)
    expect(mockQuery.mock.calls.some((c) => /INSERT INTO payment_refusals/.test(String(c[0])))).toBe(false)
  })

  // #3494 review round 2 (N3), still true under #3564: the SAME error
  // class's "included but reverted" variant is a KNOWN, confirmed outcome
  // (an EVM revert rolls back every state change — no funds moved), so it
  // must NOT answer submission_outcome_unknown; it books `failed` and falls
  // through to the generic code.
  it('an "included but reverted" SubmittedUserOpFailedError (a KNOWN, confirmed outcome) books failed and answers onchain_execution_failed, never submission_outcome_unknown', async () => {
    primeDb(AUTH, intentById(intentRow()), CLAIM_OK, FAIL_WRITE)
    delegationMocks.submitDelegationPayment.mockRejectedValueOnce(
      new SubmittedUserOpFailedError('redemption UserOp 0xabc included but reverted', '0xabc', 'included_reverted'),
    )

    const res = await sign()

    expect(res.statusCode).toBe(502)
    expect(res.json().error_code).toBe('onchain_execution_failed')
  })

  it('AA24 signature rejection: error_code signature_rejected, remedy names a NEW payment', async () => {
    primeDb(AUTH, intentById(intentRow()), CLAIM_OK, FAIL_WRITE)
    delegationMocks.submitDelegationPayment.mockRejectedValueOnce(
      new Error('UserOperation reverted during simulation: AA24 signature error'),
    )

    const res = await sign()

    expect(res.statusCode).toBe(502)
    const body = res.json()
    expect(body.status).toBe('failed')
    expect(body.error_code).toBe('signature_rejected')
    expect(body.message).toMatch(/update the signer/i)
    expect(body.message).toMatch(/new payment/i)
    // The bundler's raw text never rides the response wholesale.
    expect(body.details.length).toBeLessThanOrEqual(300 + 1)
  })

  it('other AA2x (AA25): error_code account_validation_failed, never names the signer', async () => {
    primeDb(AUTH, intentById(intentRow()), CLAIM_OK, FAIL_WRITE)
    delegationMocks.submitDelegationPayment.mockRejectedValueOnce(
      new Error('UserOperation reverted during simulation: AA25 invalid account nonce'),
    )

    const res = await sign()

    expect(res.statusCode).toBe(502)
    const body = res.json()
    expect(body.status).toBe('failed')
    expect(body.error_code).toBe('account_validation_failed')
    expect(body.message).toMatch(/new payment/i)
    expect(body.message).not.toMatch(/signer/i)
    // The on-chain AA code is still visible, bounded, in details.
    expect(body.details).toMatch(/AA25/)
  })

  function taskBudgetRow(overrides: Record<string, unknown> = {}) {
    return {
      id: TASK_BUDGET_ID,
      agent_id: AGENT.id,
      chain_id: AGENT.chain_id,
      token_address: USDC,
      recipient_address: null,
      parent_delegation_hash: BUDGET_DELEGATION_HASH,
      delegation_hash: TASK_BUDGET_DELEGATION_HASH,
      delegation_json: '{}',
      label: null,
      max_atomic: '100000',
      status: 'open',
      expires_at: '2099-01-01T00:00:00.000Z',
      prepared_user_op: null,
      close_tx_hash: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      opened_at: '2026-01-01T00:00:00.000Z',
      closed_at: null,
      ...overrides,
    }
  }

  it('task-budget transfer-cap revert, confirmed by a fresh enforcer read: error_code task_budget_exceeded', async () => {
    primeDb(
      AUTH,
      intentById(intentRow({ task_budget_id: TASK_BUDGET_ID })),
      CLAIM_OK,
      FAIL_WRITE,
      [/FROM agent_task_budgets/, () => ({ rows: [taskBudgetRow()] })],
    )
    // Fully spent: remainingAtomic = 0 < amountAtomic (100000).
    mockReadSpent.mockResolvedValueOnce(100000n)
    delegationMocks.submitDelegationPayment.mockRejectedValueOnce(
      new Error(hexRevert('ERC20TransferAmountEnforcer:allowance-exceeded')),
    )

    const res = await sign()

    expect(res.statusCode).toBe(502)
    const body = res.json()
    expect(body.status).toBe('failed')
    expect(body.error_code).toBe('task_budget_exceeded')
    expect(body.task_budget_id).toBe(TASK_BUDGET_ID)
    expect(body.remaining_atomic).toBe('0')
    expect(body.max_atomic).toBe('100000')
    // #3494 review round 1 (N2): the failure is booked on the intent row
    // (the FAIL_WRITE route matched), and NO payment_refusals row is
    // written — `refuse(..., null)` never attempts the write.
    expect(mockQuery.mock.calls.some((c) => /INSERT INTO payment_refusals/.test(String(c[0])))).toBe(false)
    expect(mockQuery.mock.calls.some((c) => /SET status = 'failed'/.test(String(c[0])))).toBe(true)
  })

  // #3494 review round 1 (N2): `=== 'exceeded'` must be the exact predicate —
  // a looser `!== 'fits'` would silently fold `unreadable` into the typed
  // 403/502, which is wrong: an unreadable chain means the revert is NOT
  // confirmed, and the honest answer is the generic fallback.
  it("task-budget cap check outcome 'fits' (a race the chain resolved in the agent's favour) falls through to the generic answer, not task_budget_exceeded", async () => {
    primeDb(
      AUTH,
      intentById(intentRow({ task_budget_id: TASK_BUDGET_ID })),
      CLAIM_OK,
      FAIL_WRITE,
      [/FROM agent_task_budgets/, () => ({ rows: [taskBudgetRow()] })],
    )
    // Nothing spent yet: remainingAtomic = 100000 >= amountAtomic (100000) — fits.
    mockReadSpent.mockResolvedValueOnce(0n)
    delegationMocks.submitDelegationPayment.mockRejectedValueOnce(
      new Error(hexRevert('ERC20TransferAmountEnforcer:allowance-exceeded')),
    )

    const res = await sign()

    expect(res.statusCode).toBe(502)
    expect(res.json().error_code).toBe('onchain_execution_failed')
  })

  it("task-budget cap check outcome 'unreadable' (the chain read failed) falls through to the generic answer, not task_budget_exceeded", async () => {
    primeDb(
      AUTH,
      intentById(intentRow({ task_budget_id: TASK_BUDGET_ID })),
      CLAIM_OK,
      FAIL_WRITE,
      [/FROM agent_task_budgets/, () => ({ rows: [taskBudgetRow()] })],
    )
    mockReadSpent.mockRejectedValueOnce(new Error('rpc unavailable'))
    delegationMocks.submitDelegationPayment.mockRejectedValueOnce(
      new Error(hexRevert('ERC20TransferAmountEnforcer:allowance-exceeded')),
    )

    const res = await sign()

    expect(res.statusCode).toBe(502)
    expect(res.json().error_code).toBe('onchain_execution_failed')
  })

  it('a DB failure while re-reading the task budget falls through to the generic answer, never a 500 (S2)', async () => {
    primeDb(
      AUTH,
      intentById(intentRow({ task_budget_id: TASK_BUDGET_ID })),
      CLAIM_OK,
      FAIL_WRITE,
      [/FROM agent_task_budgets/, () => { throw new Error('connection reset') }],
    )
    delegationMocks.submitDelegationPayment.mockRejectedValueOnce(
      new Error(hexRevert('ERC20TransferAmountEnforcer:allowance-exceeded')),
    )

    const res = await sign()

    expect(res.statusCode).toBe(502)
    expect(res.json().error_code).toBe('onchain_execution_failed')
  })

  it('period-budget revert, confirmed by a fresh delegation read: error_code delegation_budget_exceeded', async () => {
    const delegationRow = {
      delegation_hash: BUDGET_DELEGATION_HASH,
      delegation_json: '{}',
      recipient_address: null,
      budget_atomic: '1000000',
    }
    primeDb(
      AUTH,
      intentById(intentRow({ budget_delegation_hash: BUDGET_DELEGATION_HASH })),
      CLAIM_OK,
      FAIL_WRITE,
      [/FROM agent_delegations/, () => ({ rows: [delegationRow] })],
    )
    // Remaining 40000 < the payment's 100000 — short by 60000.
    mockReadRemaining.mockResolvedValueOnce({ remainingAtomic: '40000', fromChain: true })
    delegationMocks.submitDelegationPayment.mockRejectedValueOnce(
      new Error(hexRevert('ERC20PeriodTransferEnforcer:transfer-amount-exceeded')),
    )

    const res = await sign()

    expect(res.statusCode).toBe(502)
    const body = res.json()
    expect(body.status).toBe('failed')
    expect(body.error_code).toBe('delegation_budget_exceeded')
    expect(body.remaining_atomic).toBe('40000')
    expect(body.shortfall_atomic).toBe('60000')
    expect(body.next_action).toBe('fund_account_or_raise_allowance')
    // #3494 review round 1 (S2): matches the create-time body, which also
    // carries `asset`.
    expect(body.asset).toBe(USDC)
  })

  it('a DB failure while re-reading the budget delegation falls through to the generic answer, never a 500 (S2)', async () => {
    primeDb(
      AUTH,
      intentById(intentRow({ budget_delegation_hash: BUDGET_DELEGATION_HASH })),
      CLAIM_OK,
      FAIL_WRITE,
      [/FROM agent_delegations/, () => { throw new Error('connection reset') }],
    )
    delegationMocks.submitDelegationPayment.mockRejectedValueOnce(
      new Error(hexRevert('ERC20PeriodTransferEnforcer:transfer-amount-exceeded')),
    )

    const res = await sign()

    expect(res.statusCode).toBe(502)
    expect(res.json().error_code).toBe('onchain_execution_failed')
  })

  it('a chain read failure while re-reading the budget delegation falls through to the generic answer', async () => {
    const delegationRow = {
      delegation_hash: BUDGET_DELEGATION_HASH,
      delegation_json: '{}',
      recipient_address: null,
      budget_atomic: '1000000',
    }
    primeDb(
      AUTH,
      intentById(intentRow({ budget_delegation_hash: BUDGET_DELEGATION_HASH })),
      CLAIM_OK,
      FAIL_WRITE,
      [/FROM agent_delegations/, () => ({ rows: [delegationRow] })],
    )
    mockReadRemaining.mockRejectedValueOnce(new Error('rpc unavailable'))
    delegationMocks.submitDelegationPayment.mockRejectedValueOnce(
      new Error(hexRevert('ERC20PeriodTransferEnforcer:transfer-amount-exceeded')),
    )

    const res = await sign()

    expect(res.statusCode).toBe(502)
    expect(res.json().error_code).toBe('onchain_execution_failed')
  })

  it('an x402/EIP-3009 funding-leg intent reports its own rail on a period-budget revert, never a hardcoded direct', async () => {
    const delegationRow = {
      delegation_hash: BUDGET_DELEGATION_HASH,
      delegation_json: '{}',
      recipient_address: null,
      budget_atomic: '1000000',
    }
    primeDb(
      AUTH,
      intentById(intentRow({
        budget_delegation_hash: BUDGET_DELEGATION_HASH,
        payment_rail: 'x402',
        source: 'x402',
      })),
      CLAIM_OK,
      FAIL_WRITE,
      [/FROM agent_delegations/, () => ({ rows: [delegationRow] })],
    )
    mockReadRemaining.mockResolvedValueOnce({ remainingAtomic: '40000', fromChain: true })
    delegationMocks.submitDelegationPayment.mockRejectedValueOnce(
      new Error(hexRevert('ERC20PeriodTransferEnforcer:transfer-amount-exceeded')),
    )

    const res = await sign()

    expect(res.statusCode).toBe(502)
    const body = res.json()
    expect(body.error_code).toBe('delegation_budget_exceeded')
    expect(body.rail).toBe('x402')
  })

  it('everything else: error_code onchain_execution_failed, bounded message replaces the old unbounded details', async () => {
    primeDb(AUTH, intentById(intentRow()), CLAIM_OK, FAIL_WRITE)
    const longDump = 'reverted with callData 0x' + 'ab'.repeat(500)
    delegationMocks.submitDelegationPayment.mockRejectedValueOnce(new Error(longDump))

    const res = await sign()

    expect(res.statusCode).toBe(502)
    const body = res.json()
    expect(body.status).toBe('failed')
    expect(body.error_code).toBe('onchain_execution_failed')
    // Bounded: nowhere near the full ~1024-char dump.
    expect(body.message.length).toBeLessThanOrEqual(301)
    expect(body.details.length).toBeLessThanOrEqual(301)
    expect(longDump.length).toBeGreaterThan(400)
    // #3494 review round 1 (N2): booked on the intent row, no ledger row.
    expect(mockQuery.mock.calls.some((c) => /SET status = 'failed'/.test(String(c[0])))).toBe(true)
    expect(mockQuery.mock.calls.some((c) => /INSERT INTO payment_refusals/.test(String(c[0])))).toBe(false)
  })

  it('GET /payments/:id bounds error_message at the read — never the full stored dump', async () => {
    const longStoredMessage = 'reverted with callData 0x' + 'ab'.repeat(500)
    primeDb(AUTH, intentById(intentRow({ status: 'failed', error_message: longStoredMessage })))

    const res = await app.inject({
      method: 'GET',
      url: `/payments/${PAYMENT_ID}`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.error_message.length).toBeLessThanOrEqual(301)
    expect(longStoredMessage.length).toBeGreaterThan(400)
    expect(longStoredMessage.startsWith(body.error_message.slice(0, -1))).toBe(true)
  })
})
