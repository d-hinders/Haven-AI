/**
 * `GET /payments/:id/sign-context` (#3271) — the direct-payment sibling of
 * `GET /x402/:id/sign-context` (#1263). Content-dispatch DB mocks
 * (`docs/contributing/ship-playbooks/backend.md` "Query mocks"); the SQL
 * itself is proven against real Postgres in the repository suites.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { assertUserOpTypedDataBinding, packedUserOperationHash, DIRECT_SIGN_CONTEXT_VERSION } from '@haven_ai/sdk'
import paymentRoutes from '../payments.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import { allowanceModuleRailRetired, sessionRailRetired } from '../../rails/execution-rail.js'
import { userOpTypedData } from '../../rails/delegation-rail.js'
import directPaymentFixture from '../../../../sdk/src/__fixtures__/direct-payment-userop.json' with { type: 'json' }

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../../db.js', () => ({ default: { query: (...args: unknown[]) => mockQuery(...args) } }))

const DELEGATE_ACCOUNT = '0x' + 'dd'.repeat(20)
vi.mock('../../rails/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/hybrid-provisioning.js')>()
  return { ...actual, computeHybridAccountAddress: async () => DELEGATE_ACCOUNT }
})

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
const RECIPIENT = '0x' + '22'.repeat(20)
const AUTH: DbRoute = [/api_key_hash = \$1/, () => ({ rows: [AGENT] })]

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

/**
 * A prepared UserOp raw enough that `toPackedUserOperation` fills every
 * unset gas field with a deterministic zero — the same shape a real prepared
 * redemption carries, minus the values this test does not need to vary.
 */
const PREPARED_USER_OP = {
  sender: DELEGATE_ACCOUNT,
  nonce: '9',
  callData: '0x' + 'ab'.repeat(64),
}

/** The typed data production code would build for `PREPARED_USER_OP`, and the
 *  v0.7 UserOp hash it commits to — the row's `sign_hash` at authorize time is
 *  exactly this, per `rails/delegation-authorization.ts`'s prepare step. */
function goldenSignData(): { typedData: unknown; hash: string } {
  const typedData = userOpTypedData(PREPARED_USER_OP, DELEGATE_ACCOUNT as `0x${string}`, AGENT.chain_id)
  // The real production digest for this operation — the same
  // `packedUserOperationHash` the client-side integrity check recomputes, so
  // a row built from this pair is what a genuine prepared redemption stores.
  const hash = packedUserOperationHash(typedData)
  return { typedData, hash }
}

function pendingIntentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    agent_id: AGENT.id,
    status: 'pending_signature',
    tx_hash: null,
    execution_rail: 'delegation',
    prepared_user_op: PREPARED_USER_OP,
    sign_hash: null, // filled per-test from goldenSignData()
    chain_id: AGENT.chain_id,
    x402_resource_url: null,
    payment_resource_url: null,
    expires_at: '2099-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('GET /payments/:id/sign-context (#3271)', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(paymentRoutes, { prefix: '/payments' })
  })
  afterAll(async () => app.close())
  beforeEach(() => vi.clearAllMocks())

  async function get(id = PAYMENT_ID) {
    return app.inject({
      method: 'GET',
      url: `/payments/${id}/sign-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
  }

  it('serves the exact rebuilt sign_data, passes the UserOp binding check, and matches the spec', async () => {
    const { typedData, hash } = goldenSignData()
    primeDb(AUTH, [/WHERE id = \$1 AND agent_id = \$2/, () => ({
      rows: [pendingIntentRow({ sign_hash: hash })],
    })])

    const res = await get()
    expect(res.statusCode).toBe(200)
    const body = res.json()

    expect(body.payment_id).toBe(PAYMENT_ID)
    expect(body.status).toBe('pending_signature')
    expect(body.direct_sign_context_version).toBe(DIRECT_SIGN_CONTEXT_VERSION)
    expect(body.sign_data.signature_scheme).toBe('eip712_userop')
    expect(body.sign_data.hash).toBe(hash)
    expect(body.sign_data.typed_data).toEqual(typedData)

    // Criterion 1: the integrity check every client runs before signing
    // PASSES against this served payload.
    expect(() => assertUserOpTypedDataBinding(body.sign_data.typed_data, body.sign_data.hash)).not.toThrow()

    expectMatchesSpec('GET', '/payments/{id}/sign-context', body)

    // Read-only.
    expect(sqlCalls().some((c) => /INSERT|UPDATE/i.test(c.sql))).toBe(false)
  })

  it('the real captured #3271 payload also passes the binding check (fixture sanity)', () => {
    expect(() =>
      assertUserOpTypedDataBinding(directPaymentFixture.typed_data, directPaymentFixture.payload_hash),
    ).not.toThrow()
  })

  it('CHARACTERIZATION: matches byte-for-byte what POST /payments\' idempotent replay serves for the same row', async () => {
    // `replayIntentBody`'s delegation branch and `getDirectSignContext` now
    // share `buildDirectSignData` (`modules/payments/direct-sign-context.ts`)
    // precisely so this cannot drift — this test is the guard on that.
    const { hash } = goldenSignData()
    const KEY = 'idem-key-1'
    primeDb(
      AUTH,
      // The account's CURRENT execution rail — read BEFORE the idempotency
      // lookup by the create route's #993/#1986 gate. This is the ONE test
      // in this file that exercises POST /payments, so it is the one that
      // needs it mocked to `delegation` (every GET-only test below never
      // reaches this query).
      [/LEFT JOIN smart_accounts/, () => ({ rows: [{ execution_rail: 'delegation' }] })],
      [/send_idempotency_key = \$2/, () => ({
        rows: [{
          id: PAYMENT_ID,
          status: 'pending_signature',
          expires_at: '2099-01-01T00:00:00.000Z',
          // The real Base USDC address (`packages/core/src/chains.ts`) — the
          // idempotent-replay lookup 409s a mismatch against what
          // `resolveToken` resolves 'USDC' to on chain 8453, so this fixture
          // must agree with production token config, not an arbitrary address.
          token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'.toLowerCase(),
          token_symbol: 'USDC',
          to_address: RECIPIENT,
          amount_raw: '10000',
          amount_human: '0.01',
          allowance_nonce: 1,
          sign_hash: hash,
          execution_rail: 'delegation',
          prepared_user_op: PREPARED_USER_OP,
          chain_id: AGENT.chain_id,
        }],
      })],
      [/WHERE id = \$1 AND agent_id = \$2/, () => ({ rows: [pendingIntentRow({ sign_hash: hash })] })],
    )

    const replayRes = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { token: 'USDC', amount: '0.01', to: RECIPIENT, idempotency_key: KEY },
    })
    expect(replayRes.statusCode).toBe(201)

    const contextRes = await get()
    expect(contextRes.statusCode).toBe(200)

    expect(contextRes.json().sign_data.typed_data).toEqual(replayRes.json().sign_data.typed_data)
    expect(contextRes.json().sign_data.hash).toBe(replayRes.json().sign_data.hash)
  })

  it('404s an unknown or foreign payment id (same answer on purpose)', async () => {
    primeDb(AUTH, [/WHERE id = \$1 AND agent_id = \$2/, () => ({ rows: [] })])
    const res = await get()
    expect(res.statusCode).toBe(404)
  })

  it('409s an x402/MPP intent, naming the x402 sign-context route', async () => {
    primeDb(AUTH, [/WHERE id = \$1 AND agent_id = \$2/, () => ({
      rows: [pendingIntentRow({ x402_resource_url: 'https://merchant.example/resource', sign_hash: `0x${'11'.repeat(32)}` })],
    })])
    const res = await get()
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('sign_context_unavailable')
    expect(res.json().error).toMatch(/x402/)
  })

  it('410s a retired-SESSION-rail intent regardless of status', async () => {
    primeDb(AUTH, [/WHERE id = \$1 AND agent_id = \$2/, () => ({
      rows: [pendingIntentRow({ execution_rail: 'session_key', sign_hash: `0x${'11'.repeat(32)}` })],
    })])
    const res = await get()
    const retired = sessionRailRetired('intent')
    expect(res.statusCode).toBe(retired.statusCode)
    expect(res.json().error).toBe(retired.body.error)
  })

  it('410s a retired-ALLOWANCE-rail intent (execution_rail null)', async () => {
    primeDb(AUTH, [/WHERE id = \$1 AND agent_id = \$2/, () => ({
      rows: [pendingIntentRow({ execution_rail: null, sign_hash: `0x${'11'.repeat(32)}` })],
    })])
    const res = await get()
    const retired = allowanceModuleRailRetired('intent')
    expect(res.statusCode).toBe(retired.statusCode)
    expect(res.json().error).toBe(retired.body.error)
  })

  it('409s an already-executed intent with its tx hash', async () => {
    primeDb(AUTH, [/WHERE id = \$1 AND agent_id = \$2/, () => ({
      rows: [pendingIntentRow({ status: 'confirmed', tx_hash: '0x' + '99'.repeat(32), sign_hash: `0x${'11'.repeat(32)}` })],
    })])
    const res = await get()
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('already_executed')
  })

  it('409s a non-pending-signature intent (not_signable)', async () => {
    primeDb(AUTH, [/WHERE id = \$1 AND agent_id = \$2/, () => ({
      rows: [pendingIntentRow({ status: 'submitted', sign_hash: `0x${'11'.repeat(32)}` })],
    })])
    const res = await get()
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('not_signable')
  })

  it('410s and lazy-expires a stale pending row', async () => {
    primeDb(AUTH, [/WHERE id = \$1 AND agent_id = \$2/, () => ({
      rows: [pendingIntentRow({
        expires_at: new Date(Date.now() - 1000).toISOString(),
        sign_hash: `0x${'11'.repeat(32)}`,
      })],
    })])
    const res = await get()
    expect(res.statusCode).toBe(410)
    expect(res.json().error_code).toBe('expired')
    expect(sqlCalls().some((c) => /UPDATE payment_intents/i.test(c.sql) && /status = 'expired'/.test(c.sql))).toBe(true)
  })

  it('409s a delegation-rail row with no stored signing payload', async () => {
    primeDb(AUTH, [/WHERE id = \$1 AND agent_id = \$2/, () => ({
      rows: [pendingIntentRow({ prepared_user_op: null, sign_hash: `0x${'11'.repeat(32)}` })],
    })])
    const res = await get()
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('sign_context_unavailable')
  })
})
