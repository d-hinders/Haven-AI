// db-mock-exempt: module-level submit-flow test (status/response-shape and
// write ORDER) — the SQL's real behaviour (the claim CAS, the confirm/fail
// booking, the outcome-pending CAS) is proven in
// infra/repositories/__tests__/payment-intents.test.ts on the real-DB harness.
/**
 * #4761 (epic #4759 slice 2) — the `POST /payments/:id/sign` submit state
 * machine, called DIRECTLY.
 *
 * The point of this file is the contract the move created: `signPayment` takes
 * plain inputs and returns a decided `{ code, body }` response, with no Fastify
 * object anywhere in the call. Every case here calls the module function
 * itself — no `app.inject`, no server, no request — and asserts the decided
 * result. The route's own wiring (auth, rate limit, the send) stays covered by
 * the untouched `routes/__tests__/payments*.test.ts` characterization suite.
 *
 * The three terminal branches the issue names are here: a confirmed submit, a
 * failed submit, and the outcome-pending branch. Each is the mutation cell for
 * its booking call — remove `confirmSubmittedIntent`, `failSubmittedIntent` or
 * `bookSubmittedOutcomePending` from the module and the matching case goes red.
 *
 * Scaffolding (the DB stub and the delegation-rail seam) is cloned from
 * `routes/__tests__/payments-sign-failure.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockQuery,
  mockSubmit,
  mockFiat,
  mockRecordGas,
  mockFeed,
  mockFunnel,
  mockReadSpent,
  mockReadRemaining,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockSubmit: vi.fn(),
  mockFiat: vi.fn(),
  mockRecordGas: vi.fn(),
  mockFeed: vi.fn(),
  mockFunnel: vi.fn(),
  mockReadSpent: vi.fn(),
  mockReadRemaining: vi.fn(),
}))

vi.mock('../../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))
vi.mock('../../../infra/fiat-values.js', () => ({
  getFiatValuesForTokenAmount: (...a: unknown[]) => mockFiat(...a),
}))
// Only the network seam of the delegation rail (bundler/EntryPoint/account) is
// mocked — the claim/confirm/fail writes below are real production code.
vi.mock('../../../rails/delegation-authorization.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../rails/delegation-authorization.js')>()
  return { ...actual, submitDelegationPayment: (...a: unknown[]) => mockSubmit(...a) }
})
vi.mock('../sponsored-gas.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sponsored-gas.js')>()
  return { ...actual, recordSponsoredUserOpGas: (...a: unknown[]) => mockRecordGas(...a) }
})
vi.mock('../../accounting/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../accounting/index.js')>()
  return { ...actual, feedSettledPaymentBestEffort: (...a: unknown[]) => mockFeed(...a) }
})
vi.mock('../../../infra/repositories/onboarding-funnel.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/repositories/onboarding-funnel.js')>()
  return { ...actual, emitFirstPaymentSettled: (...a: unknown[]) => mockFunnel(...a) }
})
// The two chain readers the failure classifier can reach — no chain here.
vi.mock('../../../infra/chain/task-budget-spent-reader.js', () => ({
  readTaskBudgetSpent: (...a: unknown[]) => mockReadSpent(...a),
}))
vi.mock('../../../infra/chain/delegation-budget-reader.js', () => ({
  readRemainingBudget: (...a: unknown[]) => mockReadRemaining(...a),
}))

const { signPayment } = await import('../sign-payment.js')
const { serializeUserOp } = await import('../../../rails/execution-rail.js')
const { SubmittedUserOpFailedError } = await import('../../../rails/delegation-rail.js')

const AGENT = {
  id: '11111111-1111-1111-1111-111111111111',
  user_id: '22222222-2222-2222-2222-222222222222',
  name: 'Sign Module Agent',
  delegate_address: '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1',
  account_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
  chain_id: 84532,
  status: 'active',
  account_type: 'delegator_hybrid',
  execution_rail: 'delegation',
}
const PAYMENT_ID = '33333333-3333-3333-3333-333333333333'
const SIGNATURE = `0x${'ab'.repeat(97)}`
const DELEGATION_HASH = `0x${'12'.repeat(32)}`
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const PREPARED_USER_OP = {
  sender: AGENT.account_address,
  nonce: 1n,
  callData: '0xdeadbeef',
}

type DbRoute = [RegExp, (sql: string, params: unknown[]) => { rows: unknown[] }]

/** Every write the state machine issues, in the order it issued them. */
let writes: string[] = []

function primeDb(...routes: DbRoute[]) {
  mockQuery.mockImplementation(async (sql: unknown, params: unknown[]) => {
    const text = String(sql)
    for (const [re, handler] of routes) {
      if (re.test(text)) {
        if (/^UPDATE payment_intents/.test(text.trim())) writes.push(labelOf(text))
        return handler(text, params)
      }
    }
    return { rows: [] }
  })
}

function labelOf(sql: string): string {
  if (/SET signature[\s\S]*status = 'submitted'/.test(sql)) return 'claim'
  if (/SET status = 'confirmed'/.test(sql)) return 'confirm'
  if (/SET status = 'failed'/.test(sql)) return 'fail'
  if (/user_op_hash/.test(sql)) return 'outcome-pending'
  if (/SET status = 'pending_signature'/.test(sql)) return 'release'
  if (/SET status = 'expired'/.test(sql)) return 'expire'
  return 'other'
}

const INTENT: DbRoute = [/FROM payment_intents\s+WHERE id/, () => ({ rows: [intentRow()] })]
const CLAIM_OK: DbRoute = [/SET signature[\s\S]*status = 'submitted'/, () => ({ rows: [{ id: PAYMENT_ID }] })]
const CONFIRM_OK: DbRoute = [/SET status = 'confirmed'/, () => ({ rows: [{ id: PAYMENT_ID }] })]
const FAIL_WRITE: DbRoute = [/SET status = 'failed'/, () => ({ rows: [] })]
const BOOK_PENDING: DbRoute = [/user_op_hash/, () => ({ rows: [{ id: PAYMENT_ID }] })]

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
    tx_hash: null,
    status: 'pending_signature',
    error_message: null,
    created_at: '2026-11-10T00:00:00.000Z',
    signed_at: null,
    submitted_at: null,
    confirmed_at: null,
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

const mppDemoRetired = () => ({ statusCode: 410, body: { error: 'mpp_demo retired' } })
const recordMachinePaymentEvidence = vi.fn(async () => undefined)

function call(overrides: Partial<Parameters<typeof signPayment>[0]> = {}) {
  return signPayment({
    agent: AGENT,
    paymentId: PAYMENT_ID,
    signature: SIGNATURE,
    log: { warn: () => {} },
    mppDemoRetired,
    recordMachinePaymentEvidence,
    ...overrides,
  })
}

describe('signPayment — the POST /payments/:id/sign submit state machine (#4761)', () => {
  beforeEach(() => {
    writes = []
    mockQuery.mockReset()
    mockSubmit.mockReset()
    mockFiat.mockReset()
    mockRecordGas.mockReset()
    mockFeed.mockReset()
    mockFunnel.mockReset()
    mockReadSpent.mockReset()
    mockReadRemaining.mockReset()
    recordMachinePaymentEvidence.mockClear()
  })

  it('a confirmed submit: 200 with the confirmed body, and the claim → submit → confirm order holds', async () => {
    primeDb(INTENT, CLAIM_OK, CONFIRM_OK)
    mockSubmit.mockImplementation(async () => {
      writes.push('submit')
      return {
        txHash: `0x${'cd'.repeat(32)}`,
        userOpHash: `0x${'ef'.repeat(32)}`,
        actualGasUsed: 100_000n,
        actualGasCost: 1_000n,
      }
    })
    mockFiat.mockResolvedValue({ usd: 0.1, eur: 0.09, sek: 1.05 })

    const decided = await call()

    expect(decided.code).toBe(200)
    const body = decided.body as Record<string, unknown>
    expect(body.status).toBe('confirmed')
    expect(body.payment_id).toBe(PAYMENT_ID)
    expect(body.tx_hash).toBe(`0x${'cd'.repeat(32)}`)
    expect(body.explorer_url).toContain(`0x${'cd'.repeat(32)}`)
    expect(body.token).toBe('USDC')
    expect(body.amount).toBe('0.10')

    // The money-path invariant: the claim lands BEFORE the submit, and the
    // terminal write AFTER it.
    expect(writes).toEqual(['claim', 'submit', 'confirm'])

    // The sponsored-gas recording rides the submit seam, on the success path.
    expect(mockRecordGas).toHaveBeenCalledTimes(1)
    expect((mockRecordGas.mock.calls[0][0] as { outcome: string }).outcome).toBe('confirmed')
    // The evidence hook and the accounting feed fire after the booking.
    expect(recordMachinePaymentEvidence).toHaveBeenCalledWith(PAYMENT_ID, AGENT.id, expect.anything())
    expect(mockFeed).toHaveBeenCalledWith(AGENT.user_id, PAYMENT_ID)
    expect(mockFunnel).toHaveBeenCalledWith(PAYMENT_ID)
  })

  it('a failed submit: 502 onchain_execution_failed, the row booked failed, and no confirm write', async () => {
    primeDb(INTENT, CLAIM_OK, FAIL_WRITE)
    mockSubmit.mockImplementation(async () => {
      writes.push('submit')
      throw new Error('bundler rejected the UserOperation: transport failure')
    })

    const decided = await call()

    expect(decided.code).toBe(502)
    const body = decided.body as Record<string, unknown>
    expect(body.status).toBe('failed')
    expect(body.error_code).toBe('onchain_execution_failed')
    expect(body.payment_id).toBe(PAYMENT_ID)
    // The bounded message rides `details`, never the raw error wholesale.
    expect(typeof body.details).toBe('string')

    // The terminal booking is the mutation cell: drop `failSubmittedIntent`
    // and this assertion goes red.
    expect(writes).toEqual(['claim', 'submit', 'fail'])
    expect(writes).not.toContain('confirm')
    // A pre-send rejection never entered the mempool — nothing was sponsored.
    expect(mockRecordGas).not.toHaveBeenCalled()
  })

  it('the outcome-pending branch: 502 submission_outcome_unknown, the row left submitted, never failed', async () => {
    primeDb(INTENT, CLAIM_OK, BOOK_PENDING, FAIL_WRITE)
    mockSubmit.mockImplementation(async () => {
      writes.push('submit')
      throw new SubmittedUserOpFailedError(
        'redemption UserOp 0xabc was sent but its receipt could not be confirmed: timeout',
        '0xabc',
        'receipt_unconfirmed',
      )
    })

    const decided = await call()

    expect(decided.code).toBe(502)
    const body = decided.body as Record<string, unknown>
    expect(body.status).toBe('submitted')
    expect(body.error_code).toBe('submission_outcome_unknown')
    expect(body.user_op_hash).toBe('0xabc')
    expect(body.message).toMatch(/do not create a new payment/i)

    // The outcome-pending booking is the mutation cell: drop
    // `bookSubmittedOutcomePending` and this assertion goes red.
    expect(writes).toEqual(['claim', 'submit', 'outcome-pending'])
    expect(writes).not.toContain('fail')
    expect(writes).not.toContain('confirm')
    // The op WAS sent, so the sponsored gas is recorded with the unknown cost.
    expect(mockRecordGas).toHaveBeenCalledTimes(1)
    expect((mockRecordGas.mock.calls[0][0] as { outcome: string }).outcome).toBe('receipt_unconfirmed')
  })

  it('a pre-claim refusal is a decided response too — 404, nothing claimed, nothing submitted', async () => {
    primeDb([/FROM payment_intents\s+WHERE id/, () => ({ rows: [] })])

    const decided = await call()

    expect(decided.code).toBe(404)
    expect(decided.body).toEqual({ error: 'Payment intent not found' })
    expect(mockSubmit).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('a retired mpp_demo intent is refused 410 before the claim, through the injected collaborator', async () => {
    primeDb([/FROM payment_intents\s+WHERE id/, () => ({ rows: [intentRow({ payment_rail: 'mpp_demo' })] })])

    const decided = await call()

    expect(decided.code).toBe(410)
    expect(decided.body).toEqual({ error: 'mpp_demo retired' })
    expect(mockSubmit).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })
})
