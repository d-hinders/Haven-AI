/**
 * Client-version refusal (#3303) on the REAL payment routes and real Postgres.
 *
 * `middleware/__tests__/client-compat.test.ts` pins the routing with fakes.
 * This file proves what the database does: a refused request writes nothing
 * (every table in the worker schema is counted before and after), the replay
 * exemption reads the handlers' own idempotency lookups, and the retired-rail
 * exemption reads the handlers' own rail seam. The shipped `CLIENT_COMPAT`
 * table is all-null, so a minimum is flagged through `clientCompatDeps(table)`,
 * which keeps the production collaborators and swaps only the table.
 *
 * One mock, copied from `payments-direct-sign-context.test.ts` for the same
 * reason: `computeHybridAccountAddress` is a collaborator this test does not
 * own, pinned so the idempotent replay's typed data is deterministic.
 */
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { PUBLISHED_CLIENT_PACKAGES, type ClientCompatEntry, type PublishedClientPackage } from '@haven_ai/core'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import paymentRoutes from '../payments.js'
import x402Routes from '../x402.js'
import machinePaymentRoutes from '../machine-payments.js'
import { clientCompatDeps, registerClientCompatHooks } from '../../middleware/client-compat.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import { userOpTypedData } from '../../rails/delegation-rail.js'
import { packedUserOperationHash } from '@haven_ai/sdk'

const DELEGATE_ACCOUNT = '0x' + 'dd'.repeat(20)
vi.mock('../../rails/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/hybrid-provisioning.js')>()
  return { ...actual, computeHybridAccountAddress: async () => DELEGATE_ACCOUNT }
})

const CHAIN_ID = 8453
const DELEGATE = '0x1a642f0e3c3af545e7acbd38b07251b3990914f1'
const RECIPIENT = '0x' + '22'.repeat(20)
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const PREPARED_USER_OP = { sender: DELEGATE_ACCOUNT, nonce: '9', callData: '0x' + 'ab'.repeat(64) }
const SIGN_HASH = packedUserOperationHash(
  userOpTypedData(PREPARED_USER_OP, DELEGATE_ACCOUNT as `0x${string}`, CHAIN_ID),
)

const MCP_OLD = '@haven_ai/mcp/0.4.0-alpha.0'
const SIGNER_OLD = '@haven_ai/signer/0.4.0-alpha.0'

function flagged(): Record<PublishedClientPackage, ClientCompatEntry> {
  const out = {} as Record<PublishedClientPackage, ClientCompatEntry>
  for (const pkg of PUBLISHED_CLIENT_PACKAGES) out[pkg] = { recommended_version: '0.6.0', min_version: '0.5.0' }
  return out
}

let seq = 0

interface Seeded {
  userId: string
  agentId: string
  apiKey: string
}

async function seedAgent(executionRail: 'delegation' | 'session_key' = 'delegation'): Promise<Seeded> {
  const n = ++seq
  const apiKey = `sk_agent_client_compat_${n}_${Date.now()}`
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`client-compat-${n}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, $3, $4, 'delegator_hybrid') RETURNING id`,
    [userId, `0x${n.toString(16).padStart(40, 'e')}`, CHAIN_ID, executionRail],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, account_id, name, status, delegate_address, api_key_hash)
     VALUES ($1, $2, 'Compat agent', 'active', $3, $4) RETURNING id`,
    [userId, account.rows[0].id, DELEGATE, createHash('sha256').update(apiKey).digest('hex')],
  )
  return { userId, agentId: agent.rows[0].id, apiKey }
}

async function seedIntent(
  owner: Seeded,
  overrides: Partial<{ status: string; send_idempotency_key: string | null; x402_idempotency_key: string | null; payment_rail: string | null }> = {},
): Promise<string> {
  const row = {
    status: 'pending_signature',
    send_idempotency_key: null,
    x402_idempotency_key: null,
    payment_rail: null,
    ...overrides,
  }
  const intent = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, account_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, expires_at, execution_rail, prepared_user_op, chain_id,
        send_idempotency_key, x402_idempotency_key, payment_rail)
     VALUES ($1, $2, $3, 'USDC', $4, $5, '10000', '0.01', $6, 1, $7,
             $8, $9, 'delegation', $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      owner.agentId,
      owner.userId,
      DELEGATE_ACCOUNT,
      BASE_USDC,
      RECIPIENT,
      DELEGATE,
      SIGN_HASH,
      row.status,
      new Date(Date.now() + 10 * 60_000).toISOString(),
      JSON.stringify(PREPARED_USER_OP),
      CHAIN_ID,
      row.send_idempotency_key,
      row.x402_idempotency_key,
      row.payment_rail,
    ],
  )
  return intent.rows[0].id
}

/** Row count of every table in this worker's schema — "nothing written" means all of them. */
async function tableCounts(): Promise<Record<string, number>> {
  const tables = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations'`,
  )
  const out: Record<string, number> = {}
  for (const { table_name } of tables.rows) {
    const res = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${table_name}"`)
    out[table_name] = Number(res.rows[0].n)
  }
  return out
}

async function intentRow(id: string) {
  return (await db.query(`SELECT * FROM payment_intents WHERE id = $1`, [id])).rows[0] as Record<string, unknown>
}

describeDb('client-version refusal on the real payment routes (#3303)', () => {
  let app: FastifyInstance
  let agent: Seeded

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    registerClientCompatHooks(app, clientCompatDeps(flagged()))
    await app.register(paymentRoutes, { prefix: '/payments' })
    await app.register(x402Routes, { prefix: '/x402' })
    await app.register(machinePaymentRoutes, { prefix: '/machine-payments' })
  })
  afterAll(async () => app.close())
  beforeEach(async () => {
    await resetDb()
    agent = await seedAgent()
  })

  const PAYMENT_BODY = { token: 'USDC', amount: '0.01', to: RECIPIENT, idempotency_key: 'fresh-key' }
  const X402_BODY = {
    url: 'https://merchant.example/paid',
    amount: '10000',
    asset: BASE_USDC,
    network: 'eip155:8453',
    payTo: RECIPIENT,
    idempotencyKey: 'fresh-x402-key',
  }

  it.each([
    ['POST', '/payments', '/payments', PAYMENT_BODY],
    ['POST', '/payments/', '/payments', PAYMENT_BODY],
    ['POST', '/machine-payments/send', '/machine-payments/send', { asset: 'USDC', recipient: RECIPIENT, amount: '0.01', idempotency_key: 'fresh-send' }],
    ['POST', '/x402', '/x402', X402_BODY],
    ['POST', '/x402/authorize', '/x402/authorize', X402_BODY],
  ] as const)('%s %s refuses a client below a flagged minimum, matches the spec\'s 426, and writes NOTHING', async (method, url, specPath, payload) => {
    const before = await tableCounts()
    const res = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${agent.apiKey}`, 'x-haven-client': MCP_OLD },
      payload,
    })
    expect(res.statusCode).toBe(426)
    expect(res.json()).toMatchObject({ error_code: 'client_outdated', client_update: { required: true, min_version: '0.5.0' } })
    expectMatchesSpec(method, specPath, res.json(), '426')
    expect(await tableCounts()).toEqual(before)
  })

  it.each([
    ['no header', undefined],
    ['a malformed header', '@haven_ai/mcp/latest'],
    ['a dev-channel snapshot', '@haven_ai/mcp/0.0.0-dev.20260925'],
  ])('%s reaches the real handler exactly as today, whatever the minimum', async (_label, header) => {
    // An invalid amount is answered by the HANDLER's own validation — a 400
    // from the route proves the request got past the refusal hook.
    const res = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: `Bearer ${agent.apiKey}`, ...(header ? { 'x-haven-client': header } : {}) },
      payload: { ...PAYMENT_BODY, amount: 'not-a-number' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error_code).not.toBe('client_outdated')
  })

  it('an idempotent replay of an accepted send is served by the handler, not refused (real send_idempotency_key lookup)', async () => {
    const id = await seedIntent(agent, { send_idempotency_key: 'accepted-key' })
    const before = await tableCounts()
    const res = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: `Bearer ${agent.apiKey}`, 'x-haven-client': MCP_OLD },
      payload: { ...PAYMENT_BODY, idempotency_key: 'accepted-key' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().payment_id).toBe(id)
    // Still below a minimum, so the replay carries the required hint.
    expect(res.json().client_update.required).toBe(true)
    expect(await tableCounts()).toEqual(before)
  })

  it('an EXPIRED x402 row does not count as a replay — the outdated client is still refused', async () => {
    await seedIntent(agent, { status: 'expired', x402_idempotency_key: 'old-key', payment_rail: 'x402' })
    const before = await tableCounts()
    const res = await app.inject({
      method: 'POST',
      url: '/x402/authorize',
      headers: { authorization: `Bearer ${agent.apiKey}`, 'x-haven-client': MCP_OLD },
      payload: { ...X402_BODY, idempotencyKey: 'old-key' },
    })
    expect(res.statusCode).toBe(426)
    expect(await tableCounts()).toEqual(before)
  })

  it('a live x402 row with the same key IS a replay and reaches the handler', async () => {
    await seedIntent(agent, { x402_idempotency_key: 'live-key', payment_rail: 'x402' })
    const res = await app.inject({
      method: 'POST',
      url: '/x402/authorize',
      headers: { authorization: `Bearer ${agent.apiKey}`, 'x-haven-client': MCP_OLD },
      payload: { ...X402_BODY, idempotencyKey: 'live-key' },
    })
    expect(res.statusCode).not.toBe(426)
  })

  it('an agent on a retired rail keeps its 410 — the real rail seam decides, not the refusal', async () => {
    const retired = await seedAgent('session_key')
    const res = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: `Bearer ${retired.apiKey}`, 'x-haven-client': MCP_OLD },
      payload: PAYMENT_BODY,
    })
    expect(res.statusCode).toBe(410)
  })

  it('the signer below its minimum is refused at sign-context: nothing served to sign, the prepared row untouched', async () => {
    const id = await seedIntent(agent)
    const before = await intentRow(id)
    const counts = await tableCounts()
    const res = await app.inject({
      method: 'GET',
      url: `/payments/${id}/sign-context`,
      headers: { authorization: `Bearer ${agent.apiKey}`, 'x-haven-client': SIGNER_OLD },
    })
    expect(res.statusCode).toBe(426)
    expect(res.json()).not.toHaveProperty('sign_data')
    expectMatchesSpec('GET', '/payments/{id}/sign-context', res.json(), '426')
    expect(res.json().client_update.upgrade_command).toMatch(/^npx -y @haven_ai\/connect@/)
    expect(await intentRow(id)).toEqual(before)
    expect(await tableCounts()).toEqual(counts)
  })

  it('an API client below ITS minimum is not refused at sign-context (only the signer is)', async () => {
    const id = await seedIntent(agent)
    const res = await app.inject({
      method: 'GET',
      url: `/payments/${id}/sign-context`,
      headers: { authorization: `Bearer ${agent.apiKey}`, 'x-haven-client': MCP_OLD },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().sign_data.hash).toBe(SIGN_HASH)
  })
})
