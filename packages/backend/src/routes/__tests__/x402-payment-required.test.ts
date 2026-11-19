/**
 * `GET /x402/:id/payment-required` (#4872 part 2b), end to end on real
 * Postgres: the merchant's challenge re-served exactly as the production
 * authorize insert stored it, agent-scoped, read-only.
 *
 * The rows are written by the REAL repository insert and read through the
 * real agent-auth lookup, never `vi.mock('db.js')`
 * (`docs/contributing/testing-strategy.md`). The one mock is
 * `computeHybridAccountAddress`, which this test does not own.
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
  const apiKey = `sk_agent_x402_payreq_${n}_${Date.now()}`
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`x402-payreq-${n}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid') RETURNING id`,
    [userId, `0x${n.toString(16).padStart(40, 'f')}`, CHAIN_ID],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, account_id, name, status, delegate_address, api_key_hash)
     VALUES ($1, $2, 'Payment-required agent', 'active', $3, $4) RETURNING id`,
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

const CHECKOUT_REQUEST = {
  version: 1,
  fields: [
    { name: 'receipt_email', required: true },
    { name: 'shipping_address', required: false },
  ],
}

describeDb('GET /x402/:id/payment-required (#4872)', () => {
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

  function read(id: string, apiKey = agent.apiKey) {
    return app.inject({
      method: 'GET',
      url: `/x402/${encodeURIComponent(id)}/payment-required`,
      headers: { authorization: `Bearer ${apiKey}` },
    })
  }

  it('401s without an agent credential', async () => {
    const id = await seedIntent(agent, 'k-401', { paymentRequired: PAYMENT_REQUIRED })
    const res = await app.inject({ method: 'GET', url: `/x402/${id}/payment-required` })
    expect(res.statusCode).toBe(401)
  })

  it("404s an unknown id and another agent's intent with the identical answer", async () => {
    const other = await seedAgent()
    const foreignId = await seedIntent(other, 'k-foreign', { paymentRequired: PAYMENT_REQUIRED })
    const foreign = await read(foreignId)
    const unknown = await read('00000000-0000-4000-8000-000000000000')
    expect(foreign.statusCode).toBe(404)
    expect(unknown.statusCode).toBe(404)
    expect(foreign.json()).toEqual(unknown.json())
  })

  it('re-serves the stored challenge verbatim, extensions included, matching the spec, and writes nothing', async () => {
    const challenge = {
      ...PAYMENT_REQUIRED,
      extensions: { ...PAYMENT_REQUIRED.extensions, 'haven-checkout-details': CHECKOUT_REQUEST },
    }
    const id = await seedIntent(agent, 'k-200', { paymentRequired: challenge })
    const before = await intentRow(id)
    const res = await read(id)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toEqual({ payment_id: id, payment_required: challenge })
    expectMatchesSpec('GET', '/x402/{id}/payment-required', body)
    expect(await intentRow(id)).toEqual(before)
  })

  it('serves an expired intent too: the challenge is static, and the read never lazy-expires', async () => {
    const id = await seedIntent(agent, 'k-old', { paymentRequired: PAYMENT_REQUIRED, expiresInMs: -60_000 })
    const res = await read(id)
    expect(res.statusCode).toBe(200)
    expect(res.json().payment_required).toEqual(PAYMENT_REQUIRED)
    expect((await intentRow(id)).status).toBe('pending_signature')
  })

  it('answers null when no challenge was stored (a pre-#1355 row, or one too large to store)', async () => {
    const id = await seedIntent(agent, 'k-none')
    const res = await read(id)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ payment_id: id, payment_required: null })
    expectMatchesSpec('GET', '/x402/{id}/payment-required', res.json())
  })

  it('409s an intent that is not x402', async () => {
    const id = await seedIntent(agent, 'k-direct', { paymentRequired: PAYMENT_REQUIRED })
    await db.query(`UPDATE payment_intents SET x402_resource_url = NULL, payment_resource_url = NULL WHERE id = $1`, [id])
    const res = await read(id)
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('payment_required_unavailable')
    expect(JSON.stringify(res.json())).not.toContain('haven-checkout-details')
  })
})
