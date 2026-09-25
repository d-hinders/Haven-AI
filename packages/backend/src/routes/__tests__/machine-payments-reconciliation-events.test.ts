/**
 * `POST /machine-payments/reconciliation-events` — the SHADOW RESIDUE suite
 * (#3031 round 2, owner decision epic #3028 2026-09-24T21:24:44Z closing
 * #3223).
 *
 * The route lives in its own file, `routes/machine-payments-reconciliation-events.ts`,
 * so the request-validation rollout can keep it in shadow while the rest of
 * the machine-payments surface is enforced: enforcement is keyed on the route
 * FILE (#3135/#3167) and the plugin has no per-operation opt-out, so while
 * the route sat in `routes/machine-payments.ts` the slice's flip enforced it
 * too — overriding the owner decision that named it the rollout's standing
 * residue (driving it synthetically would write a false merchant rejection
 * into a payment's ledger).
 *
 * What THIS suite owns is the shadow POSTURE, which no other suite states:
 *
 *   1. a conformant request is handled exactly as before (202, the insert
 *      runs) — shadow changes no answer;
 *   2. an off-spec request is COUNTED as a would-refusal (and its traffic
 *      counted as `seen`) but STILL reaches the handler, whose own rungs
 *      answer — the refusal envelope must NOT appear while the route is
 *      shadowed, which is also why this file's handler kept the shape rungs
 *      its enforced siblings deleted;
 *   3. auth still runs first (401).
 *
 * The handler's semantic characterization (confirmed-payment requirement,
 * duplicate-report rule, tx-hash agreement, 404 scoping) stays in
 * `machine-payments.test.ts`, which registers this module beside its former
 * module — production wiring, shadow included.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import machinePaymentsReconciliationEventsRoutes from '../machine-payments-reconciliation-events.js'
// Production wiring — the plugin decides shadow vs enforce per route FILE.
import {
  installRequestValidation,
  requestValidationOpsSnapshot,
} from '../../openapi/request-validation.js'

const { mockQuery, fiatMocks, reportingMocks } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  fiatMocks: {
    getFiatValuesForTokenAmount: vi.fn(),
    getBookTimeCapture: vi.fn().mockResolvedValue(null),
  },
  reportingMocks: {
    lateAttachMerchantReceipt: vi.fn().mockResolvedValue(undefined),
    feedSettledPaymentBestEffort: vi.fn(),
  },
}))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

vi.mock('../../infra/fiat-values.js', () => fiatMocks)

vi.mock('../../modules/fee/index.js', () => ({
  quoteFee: () => ({ paymentId: '', rail: '', feeAtomic: 0n, feeToken: '', basisPoints: 0, isZero: true }),
  recordSettledFee: async () => {},
}))

vi.mock('../../modules/accounting/index.js', () => reportingMocks)

const AGENT = {
  id: '11111111-1111-1111-1111-111111111111',
  user_id: '22222222-2222-2222-2222-222222222222',
  name: 'Payment Agent',
  delegate_address: '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1',
  account_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
  chain_id: 8453,
  status: 'active',
}
const PAYMENT_ID = '33333333-3333-3333-3333-333333333333'
const TX_HASH = `0x${'ab'.repeat(32)}`

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

const sqlCalls = () => mockQuery.mock.calls.map((c) => ({ sql: String(c[0]), params: c[1] as unknown[] }))

const AUTH: DbRoute = [/api_key_hash = \$1/, () => ({ rows: [AGENT] })]

/** findReconciliationIntent / findIntentForEvidenceScoped share this shape. */
const intentById = (row: Record<string, unknown> | null): DbRoute => [
  /FROM payment_intents\s+WHERE id = \$1 AND agent_id = \$2/,
  () => ({ rows: row ? [row] : [] }),
]

function confirmedPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    kind: 'payment_intent',
    agent_id: AGENT.id,
    user_id: AGENT.user_id,
    account_address: AGENT.account_address,
    chain_id: 8453,
    token_symbol: 'USDC',
    token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    to_address: '0x15179876c595922999c2d5dc7c23cc7711fe799a',
    amount_raw: '10000',
    amount_human: '0.01',
    delegate_address: AGENT.delegate_address,
    tx_hash: TX_HASH,
    status: 'confirmed',
    payment_rail: 'mpp_demo',
    ...overrides,
  }
}

const RECON_INSERT: DbRoute = [
  /INSERT INTO machine_payment_reconciliation_events/,
  () => ({ rows: [{ id: 'event-123', status: 'open', created_at: '2026-05-15T12:00:00.000Z' }] }),
]

const CONFORMANT_BODY = {
  paymentId: PAYMENT_ID,
  rail: 'mpp_demo',
  eventType: 'merchant_retry_rejected_after_payment',
  txHash: TX_HASH,
  reason: 'Merchant returned HTTP 402 after payment',
  details: { retryStatus: 402 },
}

describe('POST /machine-payments/reconciliation-events — the shadow residue (#3031 round 2, #3223)', () => {
  let app: FastifyInstance
  // The plugin's counters are per-install (cumulative across this suite's
  // requests), so every assertion is a DELTA against the snapshot taken
  // before each test.
  let countersBefore: ReturnType<typeof requestValidationOpsSnapshot>

  beforeAll(async () => {
    app = Fastify({ logger: false })
    // Production wiring, stated honestly: dev boots the plugin in `enforce`
    // mode, and THIS file is deliberately NOT in `enforcedModules` (owner
    // decision — the route stays shadowed), so the schema is attached with
    // `attachValidation` and a would-refusal only LOGS. That is the posture
    // under test here, not an accident of the wiring.
    installRequestValidation(app, { mode: 'enforce', enforcedModules: [] })
    await app.register(machinePaymentsReconciliationEventsRoutes, { prefix: '/machine-payments' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
    for (const mock of Object.values(fiatMocks)) mock.mockReset()
    reportingMocks.lateAttachMerchantReceipt.mockClear()
    countersBefore = requestValidationOpsSnapshot()
  })

  it('a conformant request is HANDLED — 202, the event insert runs, nothing coerced or refused', async () => {
    primeDb(AUTH, intentById(confirmedPayment()), RECON_INSERT)

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/reconciliation-events',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: CONFORMANT_BODY,
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      event_id: 'event-123',
      status: 'open',
      payment_id: PAYMENT_ID,
    })
    // The handler really did its work — shadow did not swallow the request.
    expect(sqlCalls().some((c) => /INSERT INTO machine_payment_reconciliation_events/.test(c.sql))).toBe(true)

    // And the shadow instruments say the same: traffic seen, zero
    // would-refusals, zero coercions — the request shadow measured is the
    // request the handler answered.
    const snapshot = requestValidationOpsSnapshot()
    expect(snapshot.seenByRoute['POST /machine-payments/reconciliation-events']).toBe(
      (countersBefore.seenByRoute['POST /machine-payments/reconciliation-events'] ?? 0) + 1,
    )
    expect(snapshot.wouldRefuse).toBe(countersBefore.wouldRefuse)
    expect(snapshot.wouldCoerce).toBe(countersBefore.wouldCoerce)
  })

  it('an off-spec body is counted as a would-refusal and STILL reaches the handler — the handler rung answers, never the envelope', async () => {
    // An OBJECT for `rail` misses the spec's `type: 'string'` and is NOT
    // scalar-coercible — an ENFORCED route would answer the 400 envelope
    // before the handler. Shadow must not: the request continues and THIS
    // file's own rung (kept, unlike its enforced siblings') produces the
    // refusal. (A number for `rail` would be coerced to a string and count
    // as `would_coerce` instead — the coercible half of the divergence.)
    primeDb(AUTH, intentById(confirmedPayment()))

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/reconciliation-events',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { ...CONFORMANT_BODY, rail: { forged: true } },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('rail is required')
    expect(response.json().error).not.toBe('Request does not match the API spec')

    // The would-refusal is the shadow record of exactly this request, and
    // the traffic was counted with it.
    const snapshot = requestValidationOpsSnapshot()
    expect(snapshot.byRouteField['POST /machine-payments/reconciliation-events body/rail']).toBe(
      (countersBefore.byRouteField['POST /machine-payments/reconciliation-events body/rail'] ?? 0) + 1,
    )
    expect(snapshot.seenByRoute['POST /machine-payments/reconciliation-events']).toBe(
      (countersBefore.seenByRoute['POST /machine-payments/reconciliation-events'] ?? 0) + 1,
    )
  })

  it('an unknown eventType reaches the handler rung too — the RECONCILIATION_EVENT_TYPES check still owns its answer', async () => {
    primeDb(AUTH, intentById(confirmedPayment()))

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/reconciliation-events',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { ...CONFORMANT_BODY, eventType: 'merchant_said_ok' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('Unsupported reconciliation event type')
    expect(sqlCalls().some((c) => /INSERT|UPDATE|DELETE/i.test(c.sql))).toBe(false)
  })

  it('a bodyless/garbage body gets the handler rung, not a schema 400', async () => {
    primeDb(AUTH)

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/reconciliation-events',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {},
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('paymentId is required')
  })

  it('still requires agent auth — an unauthenticated request never reaches the handler', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/reconciliation-events',
      payload: CONFORMANT_BODY,
    })

    expect(response.statusCode).toBe(401)
    expect(sqlCalls().some((c) => /INSERT|UPDATE|DELETE/i.test(c.sql))).toBe(false)
  })

  it('the semantic layer is untouched: an unconfirmed payment is still refused 409 with nothing written', async () => {
    primeDb(AUTH, intentById(confirmedPayment({ status: 'pending_signature', tx_hash: null })))

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/reconciliation-events',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: CONFORMANT_BODY,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('Reconciliation events require a confirmed payment')
    expect(sqlCalls().some((c) => /INSERT|UPDATE|DELETE/i.test(c.sql))).toBe(false)
  })
})
