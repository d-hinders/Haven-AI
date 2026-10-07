/**
 * `GET /x402/by-idempotency-key/:key` (#3739) and the real-database
 * sign-context round trip of a stored `payment_required` (#3739, criterion 4,
 * point 3), end to end on real Postgres.
 *
 * Every assertion is about what the route reads from, or writes to,
 * `payment_intents` (agent scoping, the `failed` exclusion, read-only-ness,
 * JSONB storage), so the rows are written by the REAL repository insert and
 * read through the real agent-auth lookup — never `vi.mock('db.js')`
 * (`docs/contributing/testing-strategy.md`). The one mock is
 * `computeHybridAccountAddress`, the counterfactual account derivation this
 * test does not own.
 */
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import { insertMachineIntent } from '../../infra/repositories/payment-intents.js'
import x402Routes from '../x402.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'

const DELEGATE_ACCOUNT = '0x' + 'dd'.repeat(20)
vi.mock('../../rails/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/hybrid-provisioning.js')>()
  return { ...actual, computeHybridAccountAddress: async () => DELEGATE_ACCOUNT }
})

const CHAIN_ID = 84532
const DELEGATE = '0x1a642f0e3c3af545e7acbd38b07251b3990914f1'
const MERCHANT = '0x' + 'ee'.repeat(20)
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const RESOURCE_URL = 'https://api.bitrefill.com/x402/invoice/pay'

/** Bitrefill-like challenge: `extensions.bazaar` carries BOTH `info` and a nested `schema`. */
const PAYMENT_REQUIRED = {
  x402Version: 2,
  resource: { url: RESOURCE_URL, description: 'Pay an invoice', mimeType: 'application/json' },
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:84532',
      amount: '10000',
      asset: USDC,
      payTo: MERCHANT,
      maxTimeoutSeconds: 300,
      extra: { name: 'USDC', version: '2' },
    },
  ],
  extensions: {
    bazaar: {
      info: {
        input: { type: 'http', method: 'POST', bodyType: 'json', body: { invoice_id: 'inv_123', zeta: [1, { b: 2, a: 1 }] } },
        output: { type: 'json', example: { status: 'paid' } },
      },
      schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          input: {
            type: 'object',
            properties: { body: { type: 'object', required: ['invoice_id'], properties: { invoice_id: { type: 'string' } } } },
            required: ['type', 'method'],
          },
          output: { type: 'object', properties: { example: { type: 'object' } } },
        },
        required: ['input'],
      },
    },
  },
}

const PREPARED_USER_OP = JSON.stringify({
  sender: DELEGATE_ACCOUNT,
  nonce: '9',
  callData: '0x' + 'ab'.repeat(64),
})
/** The erc7710 settlement-state shape: a `{child, budget}` pair (contents irrelevant to the lookup). */
const ERC7710_STATE = JSON.stringify({ child: { delegate: DELEGATE }, budget: { delegate: DELEGATE } })

let seq = 0

interface Seeded {
  userId: string
  agentId: string
  apiKey: string
}

async function seedAgent(): Promise<Seeded> {
  const n = ++seq
  const apiKey = `sk_agent_x402_by_key_${n}_${Date.now()}`
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`x402-by-key-${n}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid') RETURNING id`,
    [userId, `0x${n.toString(16).padStart(40, 'f')}`, CHAIN_ID],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, account_id, name, status, delegate_address, api_key_hash)
     VALUES ($1, $2, 'By-key agent', 'active', $3, $4) RETURNING id`,
    [userId, account.rows[0].id, DELEGATE, createHash('sha256').update(apiKey).digest('hex')],
  )
  return { userId, agentId: agent.rows[0].id, apiKey }
}

/** A real x402 intent written by the production insert (the same `JSON.stringify` of metadata). */
async function seedIntent(
  owner: Seeded,
  key: string,
  opts: {
    scheme?: 'eip3009' | 'erc7710' | null
    preparedUserOp?: string
    paymentRequired?: unknown
    status?: string
    expiresInMs?: number
  } = {},
): Promise<string> {
  const scheme = opts.scheme === undefined ? 'eip3009' : opts.scheme
  const row = await insertMachineIntent({
    agent: {
      id: owner.agentId,
      user_id: owner.userId,
      account_address: '0x' + 'aa'.repeat(20),
      chain_id: CHAIN_ID,
      delegate_address: DELEGATE,
    },
    rail: 'x402',
    payTo: MERCHANT,
    tokenSymbol: 'USDC',
    tokenAddress: USDC,
    amountRaw: 10_000n,
    amountHuman: '0.01',
    allowanceNonce: 0,
    signHash: `0x${'56'.repeat(32)}`,
    resourceUrl: RESOURCE_URL,
    category: null,
    merchantAddress: MERCHANT,
    challengeId: null,
    idempotencyKey: key,
    metadata: {
      network: 'eip155:84532',
      ...(scheme ? { settlement_scheme: scheme } : {}),
      payment_required: opts.paymentRequired ?? null,
    },
    executionRail: 'delegation',
    preparedUserOp: opts.preparedUserOp ?? (scheme === 'erc7710' ? ERC7710_STATE : PREPARED_USER_OP),
    conflictTarget: 'x402_idempotency_key',
  })
  if (!row) throw new Error('seed insert returned no row')
  const id = row.id as string
  // `payment_intents.expires_at` has a column default; pin it and the status per case.
  await db.query(`UPDATE payment_intents SET status = $2, expires_at = $3 WHERE id = $1`, [
    id,
    opts.status ?? 'pending_signature',
    new Date(Date.now() + (opts.expiresInMs ?? 10 * 60_000)),
  ])
  return id
}

async function intentRow(id: string) {
  const res = await db.query(`SELECT * FROM payment_intents WHERE id = $1`, [id])
  return res.rows[0] as Record<string, unknown>
}

describeDb('GET /x402/by-idempotency-key/:key (#3739)', () => {
  let app: FastifyInstance
  let agent: Seeded

  beforeAll(async () => {
    process.env.X402_BINDING_PRIVATE_KEY =
      '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(x402Routes, { prefix: '/x402' })
  })
  afterAll(async () => app.close())
  beforeEach(async () => {
    await resetDb()
    agent = await seedAgent()
  })

  function byKey(key: string, apiKey = agent.apiKey) {
    return app.inject({
      method: 'GET',
      url: `/x402/by-idempotency-key/${encodeURIComponent(key)}`,
      headers: { authorization: `Bearer ${apiKey}` },
    })
  }

  it('404s an unknown key', async () => {
    const res = await byKey('x402:nothing-here')
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'No x402 payment found for this idempotency key' })
  })

  it("404s another agent's key with the identical answer (not-found and not-yours are one answer)", async () => {
    const other = await seedAgent()
    await seedIntent(other, 'shared-key')
    const foreign = await byKey('shared-key')
    const unknown = await byKey('never-used')
    expect(foreign.statusCode).toBe(404)
    expect(foreign.json()).toEqual(unknown.json())
  })

  it('401s without an agent credential', async () => {
    const res = await app.inject({ method: 'GET', url: '/x402/by-idempotency-key/k' })
    expect(res.statusCode).toBe(401)
  })

  it('200s a pending eip3009 intent with the contract fields, matching the spec', async () => {
    const id = await seedIntent(agent, 'x402:abc/def?g=1', { scheme: 'eip3009' })
    const res = await byKey('x402:abc/def?g=1') // exercises URL-encoding of / and ?
    expect(res.statusCode).toBe(200)
    const body = res.json()
    const row = await intentRow(id)
    expect(body).toEqual({
      payment_id: id,
      status: 'pending_signature',
      settlement_scheme: 'eip3009',
      resource_url: RESOURCE_URL,
      expires_at: new Date(row.expires_at as string).toISOString(),
      window_open: true,
      task_budget_id: null,
      amount_atomic: '10000',
      network: 'eip155:84532',
    })
    expectMatchesSpec('GET', '/x402/by-idempotency-key/{key}', body)
  })

  it('200s an erc7710 intent with settlement_scheme erc7710', async () => {
    const id = await seedIntent(agent, 'k-7710', { scheme: 'erc7710' })
    const res = await byKey('k-7710')
    expect(res.statusCode).toBe(200)
    expect(res.json().payment_id).toBe(id)
    expect(res.json().settlement_scheme).toBe('erc7710')
    expect(res.json().window_open).toBe(true)
  })

  it('derives erc7710 from the stored {child, budget} state when the metadata names no scheme, and null when unknowable', async () => {
    await seedIntent(agent, 'k-derived', { scheme: null, preparedUserOp: ERC7710_STATE })
    await seedIntent(agent, 'k-unknown', { scheme: null })
    expect((await byKey('k-derived')).json().settlement_scheme).toBe('erc7710')
    expect((await byKey('k-unknown')).json().settlement_scheme).toBeNull()
  })

  it('reports window_open false for a past-expiry pending row and does NOT change the row', async () => {
    const id = await seedIntent(agent, 'k-stale', { expiresInMs: -60_000 })
    const before = await intentRow(id)
    const res = await byKey('k-stale')
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('pending_signature')
    expect(res.json().window_open).toBe(false)
    // Read-only: no lazy-expire, no write of any kind.
    expect(await intentRow(id)).toEqual(before)
    expect((await intentRow(id)).status).toBe('pending_signature')
  })

  it('reports window_open false for a non-pending row even with a future expiry', async () => {
    await seedIntent(agent, 'k-confirmed', { status: 'confirmed' })
    const res = await byKey('k-confirmed')
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('confirmed')
    expect(res.json().window_open).toBe(false)
  })

  it('does not return a failed row', async () => {
    await seedIntent(agent, 'k-failed', { status: 'failed' })
    const res = await byKey('k-failed')
    expect(res.statusCode).toBe(404)
  })
})

describeDb('x402 sign-context round trip of a stored payment_required (#3739)', () => {
  let app: FastifyInstance
  let agent: Seeded

  beforeAll(async () => {
    process.env.X402_BINDING_PRIVATE_KEY =
      '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(x402Routes, { prefix: '/x402' })
  })
  afterAll(async () => app.close())
  beforeEach(async () => {
    await resetDb()
    agent = await seedAgent()
  })

  it('returns the Bitrefill-like challenge, bazaar.info AND nested bazaar.schema, deep-equal after JSONB', async () => {
    const id = await seedIntent(agent, 'k-roundtrip', { paymentRequired: PAYMENT_REQUIRED })

    // The stored copy really went through JSONB (the type that reorders keys).
    const { rows } = await db.query<{ t: string }>(
      `SELECT pg_typeof(machine_metadata)::text AS t FROM payment_intents WHERE id = $1`,
      [id],
    )
    expect(rows[0].t).toBe('jsonb')

    const res = await app.inject({
      method: 'GET',
      url: `/x402/${id}/sign-context`,
      headers: { authorization: `Bearer ${agent.apiKey}` },
    })
    expect(res.statusCode).toBe(200)
    const returned = res.json().payment_required as typeof PAYMENT_REQUIRED
    // `toEqual`, never a byte compare: JSONB reorders object keys.
    expect(returned).toEqual(PAYMENT_REQUIRED)
    expect(returned.extensions.bazaar.schema).toEqual(PAYMENT_REQUIRED.extensions.bazaar.schema)
    expect(returned.extensions.bazaar.info).toEqual(PAYMENT_REQUIRED.extensions.bazaar.info)
    expect(Object.keys(returned.extensions.bazaar).sort()).toEqual(['info', 'schema'])
  })
})
