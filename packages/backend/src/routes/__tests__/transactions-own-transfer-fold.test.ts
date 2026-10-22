import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import transactionRoutes from '../transactions.js'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import { installRequestValidation } from '../../openapi/request-validation.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'

vi.mock('../../modules/transactions/serve-time.js', () => ({
  serveTimeAmount: vi.fn(async () => null),
}))

const ACCOUNT_A = '0x1111111111111111111111111111111111111111'
const ACCOUNT_B = '0x2222222222222222222222222222222222222222'
const ACCOUNT_A_ID = '11111111-1111-4111-8111-111111111111'
const ACCOUNT_B_ID = '22222222-2222-4222-8222-222222222222'
const TX_HASH = `0x${'ab'.repeat(32)}`

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function stubOwnTransferExplorer(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/api/v1/safes/') && url.includes('/transfers/')) {
      return jsonResponse({ count: 0, next: null, previous: null, results: [] })
    }
    if (url.includes('/addresses/') && url.includes('/token-transfers')) {
      return jsonResponse({ items: [], next_page_params: null })
    }
    if (url.includes('/addresses/') && url.includes('/transactions')) {
      return jsonResponse({
        items: [{
          hash: TX_HASH,
          block_number: 123,
          timestamp: '2026-10-22T12:00:00Z',
          from: { hash: ACCOUNT_A },
          to: { hash: ACCOUNT_B },
          value: '1000000000000000000',
          gas_limit: '21000',
          gas_used: '21000',
          status: 'ok',
          method: null,
        }],
        next_page_params: null,
      })
    }
    throw new Error(`Unexpected fetch URL: ${url}`)
  }))
}

async function seedUserAndAccounts(): Promise<string> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash)
     VALUES ('own-transfer-fold@test.example', 'x')
     RETURNING id`,
  )
  await db.query(
    `INSERT INTO smart_accounts
       (id, user_id, account_address, chain_id, name, execution_rail, account_type)
     VALUES
       ($1, $3, $4, 8453, 'Main', 'delegation', 'delegator_hybrid'),
       ($2, $3, $5, 8453, 'Savings', 'delegation', 'delegator_hybrid')`,
    [ACCOUNT_A_ID, ACCOUNT_B_ID, user.rows[0].id, ACCOUNT_A, ACCOUNT_B],
  )
  return user.rows[0].id
}

describeDb('opt-in own-account transfer folding (#4265, real DB)', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/transactions.ts'] })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(transactionRoutes, { prefix: '/transactions' })
  })

  beforeEach(async () => {
    await resetDb()
    const userId = await seedUserAndAccounts()
    token = app.jwt.sign({ sub: userId, email: 'fold@example.com' })
    stubOwnTransferExplorer()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  afterAll(async () => {
    await app.close()
  })

  async function get(url: string) {
    return app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${token}` },
    })
  }

  it('leaves both legs unchanged unless the exact value 1 is requested', async () => {
    const baseline = await get('/transactions?fresh=1&limit=100')
    const zero = await get('/transactions?fresh=1&limit=100&foldOwnTransfers=0')
    const word = await get('/transactions?fresh=1&limit=100&foldOwnTransfers=true')

    expect(baseline.statusCode).toBe(200)
    for (const response of [baseline, zero, word]) {
      expect(response.statusCode).toBe(200)
      expect(response.json().transactions).toHaveLength(2)
      expect(
        response
          .json()
          .transactions.every(
            (row: { ownTransfer?: unknown }) => row.ownTransfer === undefined,
          ),
      ).toBe(true)
    }
    expect(zero.body).toBe(baseline.body)
    expect(word.body).toBe(baseline.body)
  })

  it('folds before count and paging, preserving the outbound leg and destination account', async () => {
    const response = await get('/transactions?fresh=1&limit=1&offset=0&foldOwnTransfers=1')

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body).toMatchObject({
      total: 1,
      hasMore: false,
      transactions: [{
        direction: 'out',
        accountId: ACCOUNT_A_ID,
        initiatedBy: 'unknown',
        ownTransfer: {
          toAccountId: ACCOUNT_B_ID,
          toAccountName: 'Savings',
          toAccountAddress: ACCOUNT_B,
        },
      }],
    })
    expectMatchesSpec('GET', '/transactions', body)
  })

  it('does not fold a per-account request even when the flag is present', async () => {
    const response = await get(
      `/transactions?fresh=1&accountId=${ACCOUNT_A_ID}&foldOwnTransfers=1`,
    )

    expect(response.statusCode).toBe(200)
    expect(response.json().transactions).toHaveLength(1)
    expect(response.json().transactions[0].ownTransfer).toBeUndefined()
  })

  it('keeps the default CSV byte-identical and emits one own-transfer row with the optional last column', async () => {
    const baseline = await get('/transactions/export.csv?fresh=1')
    const folded = await get('/transactions/export.csv?fresh=1&foldOwnTransfers=1')

    expect(baseline.body).not.toContain('to_account_name')
    expect(baseline.body.slice(1).split('\r\n')).toHaveLength(3)
    const [header, row] = folded.body.slice(1).split('\r\n')
    expect(header.endsWith(',to_account_name')).toBe(true)
    expect(row).toContain('"own_transfer"')
    expect(row).toContain('"out"')
    expect(row.endsWith('"Savings"')).toBe(true)
    expect(folded.headers['x-export-row-count']).toBe('1')
  })
})
