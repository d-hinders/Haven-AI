import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'

/**
 * The Safe / AllowanceModule rail CANNOT SPEND (#1986, epic #1440 slice 3).
 *
 * This file is the single place that proves the legacy rail refuses to move
 * money, the way `safe-inflow-retired.test.ts` is the single place that proves
 * it refuses new accounts (#1984). It is the #834 session-rail tombstone
 * applied to the rail that actually held funds.
 *
 * **The entry-point table below IS the definition of the closure.** It was
 * built by asking "what can EXECUTE a spend on this rail", not "what routes
 * does the ticket name" — the #1984 lesson, where enumerating writers instead
 * of callers turned three inflows into four. The ticket named `POST /payments`
 * and "x402 machine-payment paths"; enumerating executors found six, and two
 * of them are the ones a scope read would have missed:
 *
 *   POST /payments                — mints the intent (ticket)
 *   POST /payments/:id/sign       — **the only caller of
 *                                   `executeAllowanceTransfer`**, so this is
 *                                   the last line between a legacy intent
 *                                   authorized BEFORE this slice and a real
 *                                   transfer. Closing only the create path
 *                                   would have left every pending intent
 *                                   executable.
 *   POST /x402/authorize, POST /x402 — the legacy funding leg (ticket)
 *   POST /machine-payments/send   — does not itself execute, but WRITES an
 *                                   intent (or an approval row) and hands
 *                                   back signing instructions. Leaving it
 *                                   open would satisfy "410 on the executor"
 *                                   while still writing rows for a payment
 *                                   that can never complete.
 *   POST /approvals/:id/approve, /proposed — the owner-facing half: approving
 *                                   hands the dashboard an executable Safe
 *                                   transaction. Pinned in `approvals.test.ts`,
 *                                   named here so the table is complete.
 *
 * Each refusal gets four assertions, because "returns 410" alone would still
 * pass if the handler had already written a row or funded the delegate on its
 * way to the refusal:
 *
 *   1. the status is 410 — not 403, which reads as a policy failure the caller
 *      can retry out of, and not 404, which reads as a transient routing error
 *      (the #834 / #1328 precedent);
 *   2. the body is `allowanceModuleRailRetired(...)` VERBATIM, compared against
 *      the producer rather than a copied string;
 *   3. NOTHING was written — no INSERT, no UPDATE — and no chain call was made:
 *      the allowance was never read, the delegate was never funded, and
 *      `executeAllowanceTransfer` was never called;
 *   4. it holds for the WHOLE retired population, not just the literal
 *      `execution_rail='allowance_module'`: the LEFT-JOIN `null` and an
 *      unknown column value reach the same executor and must refuse too.
 *
 * Two further assertions exist because they are the ones most likely to rot:
 *
 *   - **401 precedes 410.** `agentAuthMiddleware` is an `onRequest` hook and
 *     every refusal here is inside the handler, so an unauthenticated caller
 *     never learns the route's disposition. Asserted, not assumed.
 *   - **The positive control.** A DELEGATION-rail account still pays, green in
 *     the same run. Without it every assertion in this file would be satisfied
 *     by deleting the payment code, and the suite would be a guard that can
 *     only say no.
 *
 * And the reads: an existing legacy account is NOT cut off from its own data.
 * The epic is explicit — "Accounts/history stay READABLE" — so the read cases
 * at the bottom pin that `GET /payments` and `GET /machine-payments/allowances`
 * still serve a legacy account. They are deliberately shallow: they assert the
 * routes still SERVE, and their semantics stay pinned where they already are.
 */

// db-mock-exempt: the contract under test is "the database is never reached",
// so the pool stand-in exists precisely so `expect(mockQuery).not.toHaveBeen
// CalledWith(INSERT…)` can be asserted at all. There is no database BEHAVIOUR
// here to prove on the real-Postgres harness (#1219) — a real database would
// make these assertions weaker, not stronger, because it cannot distinguish
// "no write was issued" from "a write was issued and changed nothing".
const { mockQuery, allowanceMocks, fiatMocks, delegationMocks, x402DelegationMocks } = vi.hoisted(
  () => ({
    mockQuery: vi.fn(),
    allowanceMocks: {
      getTokenAllowance: vi.fn(),
      getLatestBlockTimeSec: vi.fn(),
      computeEffectiveAllowance: vi.fn(),
      generateTransferHash: vi.fn(),
      recoverSigner: vi.fn(),
      executeAllowanceTransfer: vi.fn(),
      getTokenBalance: vi.fn(),
      getProvider: vi.fn(),
      getRelayerWallet: vi.fn(),
    },
    fiatMocks: {
      getFiatValuesForTokenAmount: vi.fn(),
      getBookTimeSekValue: vi.fn().mockResolvedValue(null),
    },
    delegationMocks: {
      prepareDelegationPayment: vi.fn(),
      submitDelegationPayment: vi.fn(),
    },
    x402DelegationMocks: {
      runDelegationAuthorize: vi.fn(),
    },
  }),
)

vi.mock('../../db.js', () => ({
  default: { query: (...args: unknown[]) => mockQuery(...args) },
}))
vi.mock('../../rails/allowance-module.js', () => allowanceMocks)
vi.mock('../../infra/fiat-values.js', () => fiatMocks)
vi.mock('../../rails/delegation-authorization.js', () => delegationMocks)
vi.mock('../../infra/repositories/allowance-nonce-watermarks.js', () => ({
  findAllowanceNonceWatermark: async () => null,
  raiseAllowanceNonceWatermark: async () => {},
}))

import paymentRoutes from '../payments.js'
import x402Routes from '../x402.js'
import machinePaymentRoutes from '../machine-payments.js'
import approvalRoutes from '../approvals.js'
import {
  allowanceModuleRailRetired,
  sessionRailRetired,
} from '../../rails/execution-rail.js'

const RETIRED_ACCOUNT = allowanceModuleRailRetired('account').body.error
const RETIRED_INTENT = allowanceModuleRailRetired('intent').body.error

const DELEGATE = '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1'
const SAFE = '0x135a9215604711AC70d970e12Caa812c53537EF4'
const RECIPIENT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const PAYMENT_ID = '33333333-3333-3333-3333-333333333333'
const SIGNATURE = `0x${'ab'.repeat(65)}`

function agentRow(executionRail: string | null) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    user_id: '22222222-2222-2222-2222-222222222222',
    name: 'Payment Agent',
    delegate_address: DELEGATE,
    safe_address: SAFE,
    chain_id: 84532,
    status: 'active',
    execution_rail: executionRail,
    account_type: executionRail === 'delegation' ? 'delegator_hybrid' : 'safe',
  }
}

function intentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    agent_id: agentRow(null).id,
    user_id: agentRow(null).user_id,
    safe_address: SAFE,
    chain_id: 84532,
    token_symbol: 'USDC',
    token_address: USDC,
    to_address: RECIPIENT.toLowerCase(),
    amount_raw: '10000',
    amount_human: '0.01',
    delegate_address: DELEGATE,
    allowance_nonce: 7,
    sign_hash: `0x${'cd'.repeat(32)}`,
    signature: null,
    tx_hash: null,
    status: 'pending_signature',
    error_message: null,
    created_at: '2026-08-24T10:00:00.000Z',
    signed_at: null,
    submitted_at: null,
    confirmed_at: null,
    expires_at: '2099-01-01T00:00:00.000Z',
    execution_rail: null,
    session_permission_id: null,
    session_user_op: null,
    payment_rail: null,
    source: 'direct',
    ...overrides,
  }
}

type DbRoute = [RegExp, () => { rows: unknown[] }]

/**
 * Content-dispatch DB stub (#1226, the `payments.test.ts` model) — never
 * positional. Deliberately GENEROUS: every unmatched query resolves happily,
 * so if a handler DID run past the guard it succeeds quietly and the
 * "nothing was written" assertions are what catch it, rather than a crash
 * that could be mistaken for the refusal working.
 */
function primeDb(...routes: DbRoute[]) {
  mockQuery.mockImplementation(async (sql: unknown) => {
    const text = String(sql)
    for (const [re, handler] of routes) {
      if (re.test(text)) return handler()
    }
    return { rows: [] }
  })
}

const authRoute = (rail: string | null): DbRoute => [
  /api_key_hash = \$1/,
  () => ({ rows: [agentRow(rail)] }),
]
/** `FIND_EXECUTION_RAIL_FOR_AGENT_SQL` — the LEFT JOIN through `agents.safe_id`. */
const railRoute = (rail: string | null): DbRoute => [
  /LEFT JOIN user_safes/,
  () => ({ rows: [{ execution_rail: rail }] }),
]
const intentRoute = (overrides: Record<string, unknown> = {}): DbRoute => [
  /FROM payment_intents/,
  () => ({ rows: [intentRow(overrides)] }),
]

const sqlCalls = () => mockQuery.mock.calls.map((c) => String(c[0]))
const writes = () => sqlCalls().filter((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql.trim()))

/** Every assertion that makes a 410 mean "fail-closed" rather than just "410". */
function expectNothingHappened() {
  expect(writes(), `a write reached the database: ${writes().join(' | ')}`).toEqual([])
  expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
  expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
  expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
}

/**
 * The retired population. `user_safes.execution_rail` is
 * `NOT NULL DEFAULT 'allowance_module'` with a three-value CHECK, so `null`
 * here means the LEFT JOIN found no Safe row — the case the issue's own
 * `execution_rail='allowance_module'` phrasing does not name, and the one a
 * literal string comparison would have left open.
 */
const RETIRED_RAILS: Array<[string, string | null]> = [
  ['the literal allowance_module marking', 'allowance_module'],
  ['a missing Safe row (LEFT JOIN null)', null],
  ['an unrecognised rail value', 'something_else'],
]

describe('the Safe / AllowanceModule rail cannot spend (#1986)', () => {
  let app: FastifyInstance
  let token: string
  const headers = { authorization: 'Bearer sk_agent_test' }

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(paymentRoutes, { prefix: '/payments' })
    await app.register(x402Routes, { prefix: '/x402' })
    await app.register(machinePaymentRoutes, { prefix: '/machine-payments' })
    await app.register(approvalRoutes, { prefix: '/approvals' })
    token = app.jwt.sign({ sub: agentRow(null).user_id, email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
    mockQuery.mockResolvedValue({ rows: [] })
    for (const m of Object.values(allowanceMocks)) m.mockReset()
    for (const m of Object.values(delegationMocks)) m.mockReset()
    for (const m of Object.values(x402DelegationMocks)) m.mockReset()
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValue({ usd: '1.00', eur: '0.92' })
    fiatMocks.getBookTimeSekValue.mockResolvedValue(null)
  })

  // ── The spend paths ──────────────────────────────────────────────────────

  describe('POST /payments — the direct spend path', () => {
    it.each(RETIRED_RAILS)('refuses %s — 410, nothing written, no chain read', async (_label, rail) => {
      primeDb(authRoute(rail), railRoute(rail))

      const res = await app.inject({
        method: 'POST',
        url: '/payments',
        headers,
        payload: { token: 'USDC', amount: '0.01', to: RECIPIENT },
      })

      expect(res.statusCode).toBe(410)
      expect(res.json().error).toBe(RETIRED_ACCOUNT)
      expectNothingHappened()
    })

    it('refuses BEFORE the idempotency replay lookup — a replay cannot resurrect sign_data', async () => {
      // Position matters, not just presence: the early gate sits above the
      // replay lookup, so a retried request cannot be handed the FIRST
      // request's still-actionable sign_data after the rail is retired. Same
      // reasoning as the #1207 review finding on the session rail.
      primeDb(authRoute('allowance_module'), railRoute('allowance_module'))

      const res = await app.inject({
        method: 'POST',
        url: '/payments',
        headers,
        payload: { token: 'USDC', amount: '0.01', to: RECIPIENT, idempotency_key: 'k-1' },
      })

      expect(res.statusCode).toBe(410)
      expect(sqlCalls().some((sql) => /send_idempotency_key/.test(sql))).toBe(false)
      expectNothingHappened()
    })
  })

  describe('POST /payments/:id/sign — the ONLY caller of executeAllowanceTransfer', () => {
    it('refuses a pending legacy intent authorized before the retirement — 410, no transfer', async () => {
      // The pre-existing-intent case is the one that decides whether this
      // slice actually closes the rail: `POST /payments` refusing new intents
      // does nothing about the ones already sitting in `pending_signature`.
      primeDb(authRoute('allowance_module'), railRoute('allowance_module'), intentRoute())
      allowanceMocks.recoverSigner.mockReturnValue(DELEGATE)

      const res = await app.inject({
        method: 'POST',
        url: `/payments/${PAYMENT_ID}/sign`,
        headers,
        payload: { signature: SIGNATURE },
      })

      expect(res.statusCode).toBe(410)
      expect(res.json().error).toBe(RETIRED_INTENT)
      expectNothingHappened()
      // Not even the signature was checked: the refusal precedes recovery.
      expect(allowanceMocks.recoverSigner).not.toHaveBeenCalled()
    })

    it('refuses an EXPIRED legacy intent without writing the expiry flip', async () => {
      // The #1120 ordering rule: a 410-with-nothing-written contract must not
      // be reached through a path that has already flipped a status on the way.
      primeDb(
        authRoute('allowance_module'),
        railRoute('allowance_module'),
        intentRoute({ expires_at: '2020-01-01T00:00:00.000Z' }),
      )

      const res = await app.inject({
        method: 'POST',
        url: `/payments/${PAYMENT_ID}/sign`,
        headers,
        payload: { signature: SIGNATURE },
      })

      expect(res.statusCode).toBe(410)
      expect(res.json().error).toBe(RETIRED_INTENT)
      expectNothingHappened()
    })
  })

  describe('x402 — the legacy funding leg', () => {
    it.each(['/x402/authorize', '/x402'])(
      'POST %s refuses a legacy account — 410, delegate never funded',
      async (url) => {
        primeDb(authRoute('allowance_module'), railRoute('allowance_module'))

        const res = await app.inject({
          method: 'POST',
          url,
          headers,
          payload: {
            url: 'https://merchant.example/resource',
            payTo: RECIPIENT,
            amount: '10000',
            asset: USDC,
            network: 'base-sepolia',
          },
        })

        expect(res.statusCode).toBe(410)
        expect(res.json().error).toBe(RETIRED_ACCOUNT)
        expectNothingHappened()
      },
    )
  })

  describe('POST /machine-payments/send — writes rows even though it does not execute', () => {
    it.each(RETIRED_RAILS)('refuses %s — 410, no intent and no approval row', async (_label, rail) => {
      primeDb(authRoute(rail), railRoute(rail))

      const res = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers,
        payload: { asset: 'USDC', recipient: RECIPIENT, amount: '0.01' },
      })

      expect(res.statusCode).toBe(410)
      expect(res.json().error).toBe(RETIRED_ACCOUNT)
      expectNothingHappened()
      expect(sqlCalls().some((sql) => /approval_requests/i.test(sql))).toBe(false)
    })
  })

  describe('the approval queue — readable and rejectable, never approvable', () => {
    it.each(['/approve', '/proposed'])(
      'POST /approvals/:id%s refuses — 410, nothing queried',
      async (suffix) => {
        primeDb()
        const res = await app.inject({
          method: 'POST',
          url: `/approvals/${PAYMENT_ID}${suffix}`,
          headers: { authorization: `Bearer ${token}` },
        })

        expect(res.statusCode).toBe(410)
        expect(res.json().error).toBe(allowanceModuleRailRetired('approval').body.error)
        // A route preHandler: Fastify short-circuits before any query at all.
        expect(mockQuery).not.toHaveBeenCalled()
      },
    )

    it('POST /approvals/:id/reject still works — the queue can still be cleared', async () => {
      primeDb([/UPDATE approval_requests/, () => ({ rows: [{ id: PAYMENT_ID }] })])
      const res = await app.inject({
        method: 'POST',
        url: `/approvals/${PAYMENT_ID}/reject`,
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ id: PAYMENT_ID, status: 'rejected' })
    })
  })

  // ── Order, and the other tombstone ───────────────────────────────────────

  describe('401 precedes 410 — auth still runs first', () => {
    it.each([
      ['/payments', { token: 'USDC', amount: '0.01', to: RECIPIENT }],
      [`/payments/${PAYMENT_ID}/sign`, { signature: SIGNATURE }],
      ['/x402/authorize', { url: 'https://m.example/r', payTo: RECIPIENT, amount: '1', asset: USDC, network: 'base-sepolia' }],
      ['/machine-payments/send', { asset: 'USDC', recipient: RECIPIENT, amount: '0.01' }],
    ])('POST %s without a key is 401, and the caller learns nothing about the rail', async (url, payload) => {
      // `agentAuthMiddleware` is an onRequest hook and every refusal above is
      // inside the handler, so this is Fastify's documented lifecycle rather
      // than a coincidence — but it is the kind of guarantee that quietly
      // inverts when someone promotes a guard to onRequest, so it is asserted.
      primeDb(authRoute('allowance_module'), railRoute('allowance_module'))

      const res = await app.inject({ method: 'POST', url, payload })

      expect(res.statusCode).toBe(401)
      expect(JSON.stringify(res.json())).not.toContain('retired')
      expectNothingHappened()
    })
  })

  describe('both tombstones coexist on the seam', () => {
    it('a session-rail account still gets #834s OWN message, not this one', async () => {
      primeDb(authRoute('session_key'), railRoute('session_key'))

      const res = await app.inject({
        method: 'POST',
        url: '/payments',
        headers,
        payload: { token: 'USDC', amount: '0.01', to: RECIPIENT },
      })

      expect(res.statusCode).toBe(410)
      expect(res.json().error).toBe(sessionRailRetired('account').body.error)
      // Named, not merely "some 410": a guard against a FORK has to say which
      // branch it is on, or it only asserts that something refused (#1984).
      expect(res.json().error).not.toBe(RETIRED_ACCOUNT)
      expectNothingHappened()
    })
  })

  // ── The positive control ─────────────────────────────────────────────────

  describe('POSITIVE CONTROL — the delegation rail still pays', () => {
    it('POST /payments on a delegation account still returns signable sign_data', async () => {
      // Without this, every assertion in this file would be satisfied by
      // deleting the payment code. This is what makes the refusals mean
      // something: the guard can say yes.
      primeDb(authRoute('delegation'), railRoute('delegation'), [
        /INSERT INTO payment_intents/,
        () => ({ rows: [intentRow({ execution_rail: 'delegation' })] }),
      ])
      delegationMocks.prepareDelegationPayment.mockResolvedValue({
        ok: true,
        prepared: {
          userOpHash: `0x${'cd'.repeat(32)}`,
          signingTypedData: { domain: {}, types: {}, primaryType: 'X', message: {} },
          delegateAccountAddress: SAFE,
          delegationHash: `0x${'12'.repeat(32)}`,
          budgetDelegationHash: `0x${'12'.repeat(32)}`,
          userOp: {},
        },
      })

      const res = await app.inject({
        method: 'POST',
        url: '/payments',
        headers,
        payload: { token: 'USDC', amount: '0.01', to: RECIPIENT },
      })

      expect(res.statusCode, `delegation rail must still pay, got ${res.body}`).toBe(201)
      expect(res.json().sign_data).toBeTruthy()
      // And it was never mistaken for the retired rail.
      expect(JSON.stringify(res.json())).not.toContain('retired')
    })
  })

  // ── The reads stay open ──────────────────────────────────────────────────

  describe('an existing legacy account is not cut off from its own data', () => {
    it('GET /payments still lists a legacy account history', async () => {
      primeDb(authRoute('allowance_module'), railRoute('allowance_module'), [
        /FROM payment_intents/,
        () => ({ rows: [intentRow({ status: 'confirmed', tx_hash: `0x${'ef'.repeat(32)}` })] }),
      ])

      const res = await app.inject({ method: 'GET', url: '/payments', headers })

      expect(res.statusCode).toBe(200)
      expect(res.json().payments).toHaveLength(1)
    })

    it('GET /machine-payments/allowances still reports a legacy accounts on-chain state', async () => {
      // Deliberately NOT a 410. The epic keeps accounts and history readable;
      // this endpoint REPORTS spend authority rather than exercising any, and
      // turning a state read into a refusal would be a read regression for
      // exactly the population being retired.
      primeDb(authRoute('allowance_module'), railRoute('allowance_module'), [
        /FROM agent_allowances|agent_allowances/,
        () => ({
          rows: [
            {
              id: 'alw-1',
              token_address: USDC,
              token_symbol: 'USDC',
              allowance_amount: '5.000000',
              reset_period_min: 1440,
            },
          ],
        }),
      ])
      allowanceMocks.getTokenAllowance.mockResolvedValue({
        amount: 5_000_000n,
        spent: 0n,
        resetTimeMin: 1440,
        lastResetMin: 0,
        nonce: 1,
      })
      allowanceMocks.getLatestBlockTimeSec.mockResolvedValue(1_800_000_000)
      allowanceMocks.computeEffectiveAllowance.mockReturnValue({
        remaining: 5_000_000n,
        effectiveSpent: 0n,
        isResetPending: false,
      })

      const res = await app.inject({ method: 'GET', url: '/machine-payments/allowances', headers })

      expect(res.statusCode).toBe(200)
      expect(res.json().allowances).toBeTruthy()
    })
  })
})
