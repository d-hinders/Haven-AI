/**
 * `GET /transactions` — the per-row `accounting` object (#2870, epic #2858).
 *
 * Pins the contract's three conditions at the route: the key is PRESENT for
 * a payment with a sync row when the account is entitled and connected,
 * ABSENT for a payment without one, and absent everywhere — with the ledger
 * never queried — when the feature gate is off or the user has no provider
 * connection. Same harness shape as `transactions-export-csv.test.ts`: the
 * explorer leg is stubbed at `fetch` and the DB leg is routed by SQL table
 * (the db-mock ratchet, #1227), so the REAL `accountingFeedAvailable` and
 * `getFortnoxConnection` run against routed rows rather than being mocked.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import transactionRoutes from '../transactions.js'
import pool from '../../db.js'
import { config } from '../../config.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'

const BASE_SAFE = '0x135a9215604711AC70d970e12Caa812c53537EF4'
const BASE_SAFE_ID = '11111111-1111-4111-8111-111111111111'
const AGENT_ID = '22222222-2222-4222-8222-222222222222'
const RECIPIENT = '0xBBBB0000000000000000000000000000000000B2'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const FED_PAYMENT = 'pi-fed'
const UNFED_PAYMENT = 'pi-unfed'

const SAFES = [{ id: BASE_SAFE_ID, safe_address: BASE_SAFE, chain_id: 8453, name: 'Base account' }]

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response)
}

/** Every explorer leg answers empty — the rows under test come from the x402 leg. */
function stubEmptyExplorers() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL) => {
      const url = String(input)
      if (url.includes('/api/v1/safes/') && url.includes('/transfers/')) {
        return jsonResponse({ count: 0, next: null, previous: null, results: [] })
      }
      return jsonResponse({ items: [], next_page_params: null })
    }),
  )
}

/** Two confirmed x402 intents: one the feed has pushed, one it never touched. */
function x402Rows() {
  return [FED_PAYMENT, UNFED_PAYMENT].map((id, i) => ({
    id,
    tx_hash: `0x${(i + 1).toString(16).padStart(64, '0')}`,
    agent_id: AGENT_ID,
    agent_name: 'Buyer',
    safe_id: BASE_SAFE_ID,
    safe_address: BASE_SAFE,
    safe_name: 'Base account',
    chain_id: 8453,
    token_symbol: 'USDC',
    token_address: USDC,
    to_address: RECIPIENT,
    amount_raw: '1000000',
    amount_human: '1',
    x402_merchant_address: null,
    x402_resource_url: null,
    payment_proof_status: 'payment_confirmed',
    payment_reconciliation_event_type: null,
    amount_sek: null,
    fx_rate_sek: null,
    fx_source: null,
    settlement_scheme: 'erc7710',
    confirmed_at: '2026-05-08T11:49:59.000Z',
    created_at: '2026-05-08T11:49:59.000Z',
  }))
}

const FED_SYNC_ROW = {
  provider: 'fortnox',
  payment_id: FED_PAYMENT,
  status: 'pushed',
  external_ref: 'fortnox:supplierinvoice:11',
  error: null,
}

interface DbRows {
  entitled?: boolean
  connected?: boolean
  syncs?: unknown[]
}

/**
 * Routes each table the request touches. The ledger read is counted
 * separately so a test can assert it was never issued.
 */
function routeDbQueries({ entitled = true, connected = true, syncs = [FED_SYNC_ROW] }: DbRows = {}) {
  const ledgerReads: unknown[][] = []
  const spy = vi.spyOn(pool, 'query').mockImplementation(
    (async (sql: unknown, params?: unknown[]) => {
      const text = String(sql)
      if (text.includes('FROM user_safes')) return { rows: SAFES }
      if (text.includes('FROM payment_intents')) return { rows: x402Rows() }
      if (text.includes('FROM account_entitlements')) return { rows: entitled ? [{ '?column?': 1 }] : [] }
      if (text.includes('FROM fortnox_connections')) {
        return {
          rows: connected
            ? [{ user_id: 'user-1', access_token: 'a', refresh_token: 'r', token_type: 'bearer', scope: '', expires_at: new Date(Date.now() + 3_600_000).toISOString() }]
            : [],
        }
      }
      if (text.includes('FROM reporting_feed_syncs')) {
        ledgerReads.push(params ?? [])
        return { rows: syncs }
      }
      return { rows: [] }
    }) as never,
  )
  return { spy, ledgerReads }
}

describe('GET /transactions — accounting badge (#2870)', () => {
  let app: FastifyInstance
  const originalHosted = config.hosted
  const originalAccountingEnabled = config.accountingEnabled

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(transactionRoutes, { prefix: '/transactions' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    // The gate's two config halves — the entitlement half is a routed row.
    ;(config as { hosted: boolean }).hosted = true
    ;(config as { accountingEnabled: boolean }).accountingEnabled = true
  })

  afterEach(() => {
    ;(config as { hosted: boolean }).hosted = originalHosted
    ;(config as { accountingEnabled: boolean }).accountingEnabled = originalAccountingEnabled
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function get(query = '?fresh=1') {
    const token = app.jwt.sign({ sub: 'user-1', email: 'test@example.com' }, { expiresIn: '1h' })
    return app.inject({
      method: 'GET',
      url: `/transactions${query}`,
      headers: { authorization: `Bearer ${token}` },
    })
  }

  function byPaymentId(body: { transactions: Array<{ paymentId?: string; accounting?: unknown }> }) {
    return new Map(body.transactions.map((tx) => [tx.paymentId, tx]))
  }

  it('carries `accounting` for a fed payment and omits the KEY for an unfed one', async () => {
    stubEmptyExplorers()
    const { ledgerReads } = routeDbQueries()

    const response = await get()

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.transactions).toHaveLength(2)
    const rows = byPaymentId(body)

    expect(rows.get(FED_PAYMENT)?.accounting).toEqual({
      provider: 'fortnox',
      status: 'pushed',
      externalRef: 'fortnox:supplierinvoice:11',
      error: null,
    })
    // Absent, not null: the key must not exist on an unfed row.
    expect(rows.get(UNFED_PAYMENT)).not.toHaveProperty('accounting')

    // ONE ledger read for the page, carrying every payment id on it.
    expect(ledgerReads).toHaveLength(1)
    expect(ledgerReads[0][0]).toBe('user-1')
    expect([...(ledgerReads[0][1] as string[])].sort()).toEqual([FED_PAYMENT, UNFED_PAYMENT].sort())

    expectMatchesSpec('GET', '/transactions', body)
  })

  it('carries the failure reason on a failed row', async () => {
    stubEmptyExplorers()
    routeDbQueries({
      syncs: [{ ...FED_SYNC_ROW, status: 'failed', external_ref: null, error: 'Fortnox 502' }],
    })

    const body = (await get()).json()

    expect(byPaymentId(body).get(FED_PAYMENT)?.accounting).toEqual({
      provider: 'fortnox',
      status: 'failed',
      externalRef: null,
      error: 'Fortnox 502',
    })
    expectMatchesSpec('GET', '/transactions', body)
  })

  it('MUTATION PROOF: absent everywhere, ledger untouched, when the account is not entitled', async () => {
    // Removing the `accountingFeedAvailable` check in
    // modules/transactions/accounting.ts makes the fed row carry a badge here.
    stubEmptyExplorers()
    const { ledgerReads } = routeDbQueries({ entitled: false })

    const body = (await get()).json()

    for (const tx of body.transactions) expect(tx).not.toHaveProperty('accounting')
    expect(ledgerReads).toHaveLength(0)
    expectMatchesSpec('GET', '/transactions', body)
  })

  it('absent everywhere, ledger untouched, when the deployment flag is off', async () => {
    ;(config as { accountingEnabled: boolean }).accountingEnabled = false
    stubEmptyExplorers()
    const { ledgerReads } = routeDbQueries()

    const body = (await get()).json()

    for (const tx of body.transactions) expect(tx).not.toHaveProperty('accounting')
    expect(ledgerReads).toHaveLength(0)
  })

  it('absent everywhere, ledger untouched, when the user has no provider connection', async () => {
    stubEmptyExplorers()
    const { ledgerReads } = routeDbQueries({ connected: false })

    const body = (await get()).json()

    for (const tx of body.transactions) expect(tx).not.toHaveProperty('accounting')
    expect(ledgerReads).toHaveLength(0)
  })

  it('skips the gate AND the ledger when the page carries no payment ids', async () => {
    stubEmptyExplorers()
    const { spy, ledgerReads } = routeDbQueries()
    // No x402 rows → no `paymentId` on any row → nothing to join.
    spy.mockImplementation(
      (async (sql: unknown) => {
        const text = String(sql)
        if (text.includes('FROM user_safes')) return { rows: SAFES }
        if (text.includes('FROM reporting_feed_syncs')) ledgerReads.push([])
        return { rows: [] }
      }) as never,
    )

    const body = (await get()).json()

    expect(body.transactions).toHaveLength(0)
    expect(ledgerReads).toHaveLength(0)
    const tablesRead = spy.mock.calls.map((c) => String(c[0]))
    expect(tablesRead.some((t) => t.includes('FROM account_entitlements'))).toBe(false)
    expect(tablesRead.some((t) => t.includes('FROM fortnox_connections'))).toBe(false)
  })
})

describe('GET /transactions — accounting badge is fail-soft (#2870)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(transactionRoutes, { prefix: '/transactions' })
    ;(config as { hosted: boolean }).hosted = true
    ;(config as { accountingEnabled: boolean }).accountingEnabled = true
  })

  afterAll(async () => {
    await app.close()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('a ledger read failure returns the page WITHOUT badges rather than a 500', async () => {
    stubEmptyExplorers()
    const { spy } = routeDbQueries()
    const healthy = spy.getMockImplementation()!
    spy.mockImplementation((async (sql: unknown, params?: unknown[]) => {
      if (String(sql).includes('FROM reporting_feed_syncs')) throw new Error('ledger unavailable')
      return (healthy as (s: unknown, p?: unknown[]) => unknown)(sql, params)
    }) as never)

    const token = app.jwt.sign({ sub: 'user-1', email: 'test@example.com' }, { expiresIn: '1h' })
    const response = await app.inject({
      method: 'GET',
      url: '/transactions?fresh=1',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.transactions).toHaveLength(2)
    for (const tx of body.transactions) expect(tx).not.toHaveProperty('accounting')
  })
})
