// db-mock-exempt: route-level handler test (status/response-shape) — the classification SQL's real behaviour (confirmed-only, chain-scoped, cross-tenant isolation, case contract) is proven in infra/repositories/__tests__/payment-intents.test.ts on the real-DB harness
/**
 * #3531 — advisory, history-only `recipient.class` on `POST /payments`.
 *
 * `previously_paid` / `new_address` is the ONLY signal this field carries,
 * computed from `hasConfirmedPaymentToRecipient` (own-confirmed-history only —
 * no own_account/contact/catalog_merchant lookup, owner decision 2026-10-01).
 * This file proves the ROUTE wiring: top-level placement, the field on a
 * fresh create, recomputation (never caching) on an idempotent replay, and —
 * the acceptance criterion that matters most on a money path — that
 * `sign_data` is BYTE-IDENTICAL whether the recipient is `previously_paid` or
 * `new_address`, and that a `new_address` payment proceeds exactly as before.
 *
 * Scaffolding cloned from `payments-period-budget.test.ts` (#3503): the full
 * delegation-rail mock stack a genuine 201 create needs, which
 * `payments.test.ts`'s own `POST /payments (create)` describe never
 * assembles (every case there answers 410 — the retired-rail gate, not a
 * rail that executes).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { getAddress } from 'viem'

const { mockQuery, mockCompute, mockCreateRail, mockReadRemaining, mockHasConfirmed } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockCompute: vi.fn(),
  mockCreateRail: vi.fn(),
  mockReadRemaining: vi.fn(),
  mockHasConfirmed: vi.fn(),
}))
vi.mock('../../infra/chain/delegation-budget-reader.js', () => ({
  readRemainingBudget: (...a: unknown[]) => mockReadRemaining(...a),
}))
vi.mock('../../db.js', () => ({
  default: { query: (...a: unknown[]) => mockQuery(...a) },
}))
vi.mock('../../rails/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/hybrid-provisioning.js')>()
  return { ...actual, computeHybridAccountAddress: (...a: unknown[]) => mockCompute(...a) }
})
vi.mock('../../rails/delegation-rail.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/delegation-rail.js')>()
  return {
    ...actual,
    delegationRailBundlerUrl: () => 'https://bundler.example/x?apikey=SECRET',
    createDelegationRail: (...a: unknown[]) => mockCreateRail(...a),
  }
})
// #3531: the one function this slice adds. Mocked directly rather than
// through the raw EXISTS SQL — its real behaviour (confirmed-only,
// chain-scoped, cross-tenant isolation) is the real-DB repository suite's
// job; this file owns only whether the ROUTE reads it, places it at the
// top level, and recomputes it on replay.
vi.mock('../../infra/repositories/payment-intents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/repositories/payment-intents.js')>()
  return { ...actual, hasConfirmedPaymentToRecipient: (...a: unknown[]) => mockHasConfirmed(...a) }
})

const paymentRoutes = (await import('../payments.js')).default

const AGENT = {
  id: '11111111-1111-1111-1111-111111111111',
  user_id: '22222222-2222-2222-2222-222222222222',
  name: 'Recipient History Payer',
  delegate_address: '0x' + 'bb'.repeat(20),
  account_address: '0x' + 'aa'.repeat(20),
  chain_id: 84532,
  status: 'active',
  account_type: 'delegator_hybrid',
  execution_rail: 'delegation',
  has_bound_account: true,
}
const DELEGATE_ACCOUNT = '0x' + 'dd'.repeat(20)
const RECIPIENT = '0x' + 'cc'.repeat(20)
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

type DbRoute = [RegExp, (sql: string, params: unknown[]) => { rows: unknown[] }]

function primeDb(...routes: DbRoute[]) {
  mockQuery.mockImplementation(async (sql: unknown, params: unknown[]) => {
    const text = String(sql)
    for (const [re, handler] of routes) {
      if (re.test(text)) return handler(text, params)
    }
    return { rows: [] }
  })
}

function delegationJson(delegator: string, salt: string) {
  return JSON.stringify({
    delegate: DELEGATE_ACCOUNT,
    delegator,
    authority: `0x${'ff'.repeat(32)}`,
    caveats: [],
    salt,
    signature: `0x${'ab'.repeat(65)}`,
  })
}
const SELECTED_JSON = delegationJson('0x' + 'e1'.repeat(20), '1')

const AUTH: DbRoute = [/api_key_hash = \$1/, () => ({ rows: [AGENT] })]
const RAIL_STATE: DbRoute = [/SELECT us.execution_rail/, () => ({ rows: [{ execution_rail: 'delegation' }] })]
const SELECTED_GRANT: DbRoute = [
  /FROM agent_delegations\s+WHERE agent_id = \$1\s+AND token_address/,
  () => ({
    rows: [
      {
        delegation_hash: `0x${'99'.repeat(32)}`,
        delegation_json: SELECTED_JSON,
        recipient_address: null,
        budget_atomic: '10000',
      },
    ],
  }),
]
const INSERT_INTENT: DbRoute = [
  /INSERT INTO payment_intents/,
  () => ({ rows: [{ id: 'intent-1', status: 'pending_signature', expires_at: '2026-09-30T00:10:00.000Z' }] }),
]
// A replay lookup keyed on `send_idempotency_key` — matched independently of
// INSERT_INTENT so a keyed re-run finds the FIRST request's row instead of
// minting a second one.
function replayRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'intent-1',
    status: 'pending_signature',
    expires_at: '2099-01-01T00:00:00.000Z',
    token_address: USDC.toLowerCase(),
    token_symbol: 'USDC',
    to_address: RECIPIENT.toLowerCase(),
    amount_raw: '5000',
    amount_human: '0.005',
    allowance_nonce: 1,
    sign_hash: `0x${'11'.repeat(32)}`,
    execution_rail: 'delegation',
    prepared_user_op: { sender: DELEGATE_ACCOUNT, nonce: '1', callData: '0xabcd' },
    chain_id: AGENT.chain_id,
    task_budget_id: null,
    sub_budget_id: null,
    ...overrides,
  }
}
const REPLAY_LOOKUP = (rows: unknown[]): DbRoute => [/send_idempotency_key = \$2/, () => ({ rows })]

describe('POST /payments: recipient.class (#3531)', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(paymentRoutes, { prefix: '/payments' })
  })
  afterAll(async () => app.close())

  const prepareRedemption = vi.fn()
  beforeEach(() => {
    mockQuery.mockReset()
    mockReadRemaining.mockReset()
    mockReadRemaining.mockResolvedValue({ remainingAtomic: '1000000000000', fromChain: true })
    mockHasConfirmed.mockReset()
    mockHasConfirmed.mockResolvedValue(false)
    mockCompute.mockReset()
    mockCompute.mockResolvedValue(DELEGATE_ACCOUNT)
    prepareRedemption.mockReset()
    prepareRedemption.mockResolvedValue({
      userOperation: { sender: DELEGATE_ACCOUNT },
      userOpHash: `0x${'11'.repeat(32)}`,
      signingTypedData: { primaryType: 'PackedUserOperation', message: { sender: DELEGATE_ACCOUNT } },
      delegateAccountAddress: DELEGATE_ACCOUNT,
    })
    mockCreateRail.mockReset()
    mockCreateRail.mockResolvedValue({
      delegateAccountAddress: DELEGATE_ACCOUNT,
      prepareRedemption,
      prepareAccountCall: vi.fn(),
      submitRedemption: vi.fn(),
    })
    primeDb(AUTH, RAIL_STATE, [/send_idempotency_key = \$2/, () => ({ rows: [] })], SELECTED_GRANT, INSERT_INTENT)
  })

  afterEach(async () => {
    // Drain any fire-and-forget write before the next test's mock resets.
    let seen = -1
    while (seen !== mockQuery.mock.calls.length) {
      seen = mockQuery.mock.calls.length
      await new Promise((r) => setTimeout(r, 25))
    }
  })

  const pay = (extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { token: 'USDC', amount: '0.005', to: RECIPIENT, ...extra },
    })

  it('carries `new_address` at the TOP LEVEL (never inside sign_data) when this agent has no confirmed payment to the recipient', async () => {
    mockHasConfirmed.mockResolvedValue(false)
    const res = await pay()
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.recipient).toEqual({ class: 'new_address' })
    expect(body.sign_data.recipient).toBeUndefined()
    expect(JSON.stringify(body.sign_data)).not.toContain('recipient')
    // The one input this route-level test owns: agent id, chain id and the
    // LOWER-CASED recipient — never the raw-cased `to` the caller sent.
    expect(mockHasConfirmed).toHaveBeenCalledWith(AGENT.id, AGENT.chain_id, RECIPIENT.toLowerCase())
  })

  it('#3531 review S1: a MIXED-CASE checksummed `to` still reaches the repo lower-cased', async () => {
    // RECIPIENT above is all-'c' — lower-casing it is a no-op, so the
    // previous test cannot catch a dropped `.toLowerCase()` in
    // classifyRecipient. A real EIP-55 checksum of the SAME address mixes
    // case on purpose; the request names this exact string.
    const checksummed = getAddress(RECIPIENT)
    expect(checksummed).not.toBe(RECIPIENT)
    expect(checksummed.toLowerCase()).toBe(RECIPIENT.toLowerCase())

    mockHasConfirmed.mockResolvedValue(false)
    const res = await pay({ to: checksummed })
    expect(res.statusCode).toBe(201)
    expect(mockHasConfirmed).toHaveBeenCalledWith(AGENT.id, AGENT.chain_id, RECIPIENT.toLowerCase())
  })

  it('carries `previously_paid` when this agent has a confirmed payment to the recipient', async () => {
    mockHasConfirmed.mockResolvedValue(true)
    const res = await pay()
    expect(res.statusCode).toBe(201)
    expect(res.json().recipient).toEqual({ class: 'previously_paid' })
  })

  it('a `new_address` payment proceeds to redemption exactly as before — no refusal, no routing change', async () => {
    mockHasConfirmed.mockResolvedValue(false)
    const res = await pay()
    expect(res.statusCode).toBe(201)
    expect(prepareRedemption).toHaveBeenCalledTimes(1)
    expect(res.json().status).toBe('pending_signature')
  })

  it('#3531 review S3: the advisory read throwing never fails the prepare — 201 WITHOUT recipient, intent still created', async () => {
    mockHasConfirmed.mockRejectedValue(new Error('transient DB blip'))
    const res = await pay()
    expect(res.statusCode).toBe(201)
    expect(prepareRedemption).toHaveBeenCalledTimes(1)
    expect(res.json().status).toBe('pending_signature')
    expect(res.json().payment_id).toBeDefined()
    // Omitted, not sent as null — a caller checking `'recipient' in body`
    // (as the hosted relay does) must see it genuinely absent.
    expect('recipient' in res.json()).toBe(false)
  })

  it('sign_data is BYTE-IDENTICAL whether the recipient is new_address or previously_paid', async () => {
    mockHasConfirmed.mockResolvedValue(false)
    const resA = await pay({ idempotency_key: 'a-key-1' })
    mockHasConfirmed.mockResolvedValue(true)
    const resB = await pay({ idempotency_key: 'a-key-2' })
    expect(resA.statusCode).toBe(201)
    expect(resB.statusCode).toBe(201)
    expect(resA.json().recipient.class).toBe('new_address')
    expect(resB.json().recipient.class).toBe('previously_paid')
    // The field the signer validates and the account signs over — pinned
    // byte-for-byte equal across both classes.
    expect(JSON.stringify(resA.json().sign_data)).toBe(JSON.stringify(resB.json().sign_data))
  })

  it('an idempotent replay RECOMPUTES recipient.class — it is never cached on the row', async () => {
    const KEY = 'replay-key-1'
    // First request: no prior confirmed payment.
    mockHasConfirmed.mockResolvedValue(false)
    const first = await pay({ idempotency_key: KEY })
    expect(first.statusCode).toBe(201)
    expect(first.json().recipient).toEqual({ class: 'new_address' })

    // Second request, SAME key: the replay path now finds the pending row
    // instead of inserting — and this agent's history has since grown (a
    // payment to this recipient confirmed between the two requests).
    primeDb(AUTH, RAIL_STATE, REPLAY_LOOKUP([replayRow()]), SELECTED_GRANT, INSERT_INTENT)
    mockHasConfirmed.mockResolvedValue(true)
    const second = await pay({ idempotency_key: KEY })
    expect(second.statusCode).toBe(201)
    expect(second.json().idempotent_replay).toBe(true)
    expect(second.json().recipient).toEqual({ class: 'previously_paid' })
    // The replay's own sign_data is still rebuilt from the STORED
    // UserOperation (the #961 discipline), unaffected by the field above.
    expect(JSON.stringify(second.json().sign_data)).toContain('dd'.repeat(20))
    // #3531 review N1: `recipient` lives at the top level ONLY — the replay's
    // sign_data must never carry it, on either request.
    expect(first.json().sign_data.recipient).toBeUndefined()
    expect(second.json().sign_data.recipient).toBeUndefined()
    expect(JSON.stringify(first.json().sign_data)).not.toContain('recipient')
    expect(JSON.stringify(second.json().sign_data)).not.toContain('recipient')
  })
})
