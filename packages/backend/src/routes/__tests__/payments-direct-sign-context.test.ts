/**
 * `GET /payments/:id/sign-context` (#3271) — the direct-payment sibling of
 * `GET /x402/:id/sign-context` (#1263), end to end on real Postgres.
 *
 * Every assertion here is about what the route reads from, or writes to,
 * `payment_intents` (ownership scoping, the refusal matrix, the lazy expiry,
 * read-only-ness), so it runs through the real agent-auth lookup and the real
 * row, never `vi.mock('db.js')` (`docs/contributing/testing-strategy.md`).
 * The one mock is `computeHybridAccountAddress`: the counterfactual account
 * derivation is a collaborator this test does not own, pinned so the typed
 * data's `domain.verifyingContract` is deterministic.
 */
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { assertUserOpTypedDataBinding, packedUserOperationHash, DIRECT_SIGN_CONTEXT_VERSION } from '@haven_ai/sdk'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import paymentRoutes from '../payments.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import { allowanceModuleRailRetired, sessionRailRetired } from '../../rails/execution-rail.js'
import { userOpTypedData } from '../../rails/delegation-rail.js'
import directPaymentFixture from '../../../../sdk/src/__fixtures__/direct-payment-userop.json' with { type: 'json' }

const DELEGATE_ACCOUNT = '0x' + 'dd'.repeat(20)
vi.mock('../../rails/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/hybrid-provisioning.js')>()
  return { ...actual, computeHybridAccountAddress: async () => DELEGATE_ACCOUNT }
})

const CHAIN_ID = 8453
const DELEGATE = '0x1a642f0e3c3af545e7acbd38b07251b3990914f1'
const RECIPIENT = '0x' + '22'.repeat(20)
/** The real Base USDC address (`packages/core/src/chains.ts`): the idempotent
 *  replay 409s a token that disagrees with what `resolveToken` gives 'USDC'. */
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const OTHER_HASH = `0x${'11'.repeat(32)}`

/**
 * A prepared UserOp raw enough that `toPackedUserOperation` fills every unset
 * gas field with a deterministic zero — the shape a real prepared redemption
 * carries, minus the values this test does not vary.
 */
const PREPARED_USER_OP = {
  sender: DELEGATE_ACCOUNT,
  nonce: '9',
  callData: '0x' + 'ab'.repeat(64),
}

/** The typed data production builds for `PREPARED_USER_OP`, and the v0.7
 *  UserOp hash it commits to — what a genuine prepared row stores as `sign_hash`. */
function goldenSignData(): { typedData: unknown; hash: string } {
  const typedData = userOpTypedData(PREPARED_USER_OP, DELEGATE_ACCOUNT as `0x${string}`, CHAIN_ID)
  return { typedData, hash: packedUserOperationHash(typedData) }
}

let seq = 0

interface Seeded {
  userId: string
  agentId: string
  apiKey: string
}

/** A user + delegation-rail account + ACTIVE agent holding a real API key. */
async function seedAgent(): Promise<Seeded> {
  const n = ++seq
  const apiKey = `sk_agent_direct_sign_${n}_${Date.now()}`
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`direct-sign-${n}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid') RETURNING id`,
    [userId, `0x${n.toString(16).padStart(40, 'f')}`, CHAIN_ID],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, account_id, name, status, delegate_address, api_key_hash)
     VALUES ($1, $2, 'Direct signer', 'active', $3, $4) RETURNING id`,
    [userId, account.rows[0].id, DELEGATE, createHash('sha256').update(apiKey).digest('hex')],
  )
  return { userId, agentId: agent.rows[0].id, apiKey }
}

/** A signable direct (non-x402) delegation-rail intent, overridable per case. */
async function seedIntent(
  owner: Seeded,
  overrides: Partial<{
    status: string
    tx_hash: string | null
    execution_rail: string | null
    prepared_user_op: unknown
    sign_hash: string
    x402_resource_url: string | null
    expires_at: string
    send_idempotency_key: string | null
  }> = {},
): Promise<string> {
  const row = {
    status: 'pending_signature',
    tx_hash: null,
    execution_rail: 'delegation',
    prepared_user_op: PREPARED_USER_OP,
    sign_hash: goldenSignData().hash,
    x402_resource_url: null,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    send_idempotency_key: null,
    ...overrides,
  }
  const intent = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, account_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, tx_hash, expires_at, execution_rail, prepared_user_op, chain_id,
        x402_resource_url, send_idempotency_key)
     VALUES ($1, $2, $3, 'USDC', $4, $5, '10000', '0.01', $6, 1, $7,
             $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id`,
    [
      owner.agentId,
      owner.userId,
      DELEGATE_ACCOUNT,
      BASE_USDC,
      RECIPIENT,
      DELEGATE,
      row.sign_hash,
      row.status,
      row.tx_hash,
      row.expires_at,
      row.execution_rail,
      row.prepared_user_op == null ? null : JSON.stringify(row.prepared_user_op),
      CHAIN_ID,
      row.x402_resource_url,
      row.send_idempotency_key,
    ],
  )
  return intent.rows[0].id
}

async function intentRow(id: string) {
  const res = await db.query(`SELECT * FROM payment_intents WHERE id = $1`, [id])
  return res.rows[0] as Record<string, unknown>
}

describeDb('GET /payments/:id/sign-context (#3271)', () => {
  let app: FastifyInstance
  let agent: Seeded

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(paymentRoutes, { prefix: '/payments' })
  })
  afterAll(async () => app.close())
  beforeEach(async () => {
    await resetDb()
    agent = await seedAgent()
  })

  function get(id: string, apiKey = agent.apiKey) {
    return app.inject({
      method: 'GET',
      url: `/payments/${id}/sign-context`,
      headers: { authorization: `Bearer ${apiKey}` },
    })
  }

  it('serves the exact rebuilt sign_data, passes the UserOp binding check, matches the spec, and writes nothing', async () => {
    const { typedData, hash } = goldenSignData()
    const id = await seedIntent(agent)
    const before = await intentRow(id)

    const res = await get(id)
    expect(res.statusCode).toBe(200)
    const body = res.json()

    expect(body.payment_id).toBe(id)
    expect(body.status).toBe('pending_signature')
    expect(body.direct_sign_context_version).toBe(DIRECT_SIGN_CONTEXT_VERSION)
    expect(body.sign_data.signature_scheme).toBe('eip712_userop')
    expect(body.sign_data.hash).toBe(hash)
    expect(body.sign_data.typed_data).toEqual(typedData)

    // Criterion 1: the integrity check every client runs before signing
    // PASSES against this served payload.
    expect(() => assertUserOpTypedDataBinding(body.sign_data.typed_data, body.sign_data.hash)).not.toThrow()

    expectMatchesSpec('GET', '/payments/{id}/sign-context', body)

    // Read-only: the row is byte-identical after the read.
    expect(await intentRow(id)).toEqual(before)
  })

  it('the real captured #3271 payload also passes the binding check (fixture sanity)', () => {
    expect(() =>
      assertUserOpTypedDataBinding(directPaymentFixture.typed_data, directPaymentFixture.payload_hash),
    ).not.toThrow()
  })

  it('CHARACTERIZATION: matches byte-for-byte what POST /payments\' idempotent replay serves for the same row', async () => {
    // `replayIntentBody`'s delegation branch and `getDirectSignContext` share
    // `buildDirectSignData` (`modules/payments/direct-sign-context.ts`)
    // precisely so this cannot drift — this test is the guard on that.
    const KEY = 'idem-key-1'
    const id = await seedIntent(agent, { send_idempotency_key: KEY })

    const replayRes = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: `Bearer ${agent.apiKey}` },
      payload: { token: 'USDC', amount: '0.01', to: RECIPIENT, idempotency_key: KEY },
    })
    expect(replayRes.statusCode).toBe(201)
    expect(replayRes.json().payment_id).toBe(id)

    const contextRes = await get(id)
    expect(contextRes.statusCode).toBe(200)

    expect(contextRes.json().sign_data.typed_data).toEqual(replayRes.json().sign_data.typed_data)
    expect(contextRes.json().sign_data.hash).toBe(replayRes.json().sign_data.hash)
  })

  it('404s an unknown id and another agent\'s id identically (same answer on purpose)', async () => {
    const other = await seedAgent()
    const foreignId = await seedIntent(other)

    const unknown = await get('00000000-0000-4000-8000-000000000000')
    const foreign = await get(foreignId)
    expect(unknown.statusCode).toBe(404)
    expect(foreign.statusCode).toBe(404)
    expect(foreign.json()).toEqual(unknown.json())
  })

  it('409s an x402/MPP intent, naming the x402 sign-context route', async () => {
    const id = await seedIntent(agent, {
      x402_resource_url: 'https://merchant.example/resource',
      sign_hash: OTHER_HASH,
    })
    const res = await get(id)
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('sign_context_unavailable')
    expect(res.json().error).toMatch(/x402/)
  })

  it('410s a retired-SESSION-rail intent regardless of status', async () => {
    const id = await seedIntent(agent, { execution_rail: 'session_key', sign_hash: OTHER_HASH })
    const res = await get(id)
    const retired = sessionRailRetired('intent')
    expect(res.statusCode).toBe(retired.statusCode)
    expect(res.json().error).toBe(retired.body.error)
  })

  it('410s a retired-ALLOWANCE-rail intent (execution_rail null)', async () => {
    const id = await seedIntent(agent, { execution_rail: null, sign_hash: OTHER_HASH })
    const res = await get(id)
    const retired = allowanceModuleRailRetired('intent')
    expect(res.statusCode).toBe(retired.statusCode)
    expect(res.json().error).toBe(retired.body.error)
  })

  it('409s an already-executed intent with its tx hash', async () => {
    const txHash = '0x' + '99'.repeat(32)
    const id = await seedIntent(agent, { status: 'confirmed', tx_hash: txHash })
    const res = await get(id)
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('already_executed')
    expect(res.json().tx_hash).toBe(txHash)
  })

  it('409s a non-pending-signature intent (not_signable)', async () => {
    const id = await seedIntent(agent, { status: 'submitted' })
    const res = await get(id)
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('not_signable')
  })

  it('410s a stale pending row and lazily expires it in the database', async () => {
    const id = await seedIntent(agent, { expires_at: new Date(Date.now() - 1000).toISOString() })
    const res = await get(id)
    expect(res.statusCode).toBe(410)
    expect(res.json().error_code).toBe('expired')
    expect((await intentRow(id)).status).toBe('expired')
  })

  it('409s a delegation-rail row with no stored signing payload', async () => {
    const id = await seedIntent(agent, { prepared_user_op: null })
    const res = await get(id)
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('sign_context_unavailable')
  })
})
