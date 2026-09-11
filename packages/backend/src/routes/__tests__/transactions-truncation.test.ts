/**
 * The truncation signal on `GET /transactions` (#2882).
 *
 * The feed asks each explorer leg for `EXPLORER_PAGE_SIZE` rows and has no
 * cursor to tell it whether more exist, so a leg that comes back holding
 * exactly that many was cut off at the window. These tests pin the boundary
 * in both directions and prove the flag survives the per-account cache, which
 * is where a naive implementation loses it.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import transactionRoutes from '../transactions.js'
import pool from '../../db.js'
import { EXPLORER_PAGE_SIZE } from '../../infra/explorer-api.js'

const SAFE = '0x135a9215604711AC70d970e12Caa812c53537EF4'
const SENDER = '0xAAAA0000000000000000000000000000000000A1'

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response)
}

/**
 * `count` native rows on the Base account. A distinct `addressSuffix` gives
 * each test its own cache key — the per-account cache lives for the module's
 * lifetime, so a shared address would let one test read another's result.
 */
function stubNativeRows(count: number) {
  const items = Array.from({ length: count }, (_, i) => ({
    hash: `0x${(i + 1).toString(16).padStart(64, '0')}`,
    block_number: 45_000_000 + i,
    timestamp: '2026-05-08T11:49:59Z',
    from: { hash: SENDER },
    to: { hash: SAFE },
    value: '1000000000000000000',
    gas_limit: '21000',
    gas_used: '21000',
    status: 'ok',
    method: null,
  }))

  const fetchMock = vi.fn((input: string | URL) => {
    const url = String(input)
    if (url.includes('/addresses/') && url.includes('/transactions')) {
      return jsonResponse({ items, next_page_params: null })
    }
    return jsonResponse({ items: [], next_page_params: null })
  })

  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function routeDbQueries(safes: unknown[]) {
  return vi.spyOn(pool, 'query').mockImplementation(
    (async (sql: unknown) => {
      if (String(sql).includes('FROM user_safes')) return { rows: safes }
      return { rows: [] }
    }) as never,
  )
}

describe('GET /transactions — truncation signal (#2882)', () => {
  let app: FastifyInstance
  let safeCounter = 0

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(transactionRoutes, { prefix: '/transactions' })
  })

  afterAll(async () => {
    await app.close()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /** A fresh address per call, so no test reads another's cached read. */
  function uniqueSafe() {
    safeCounter += 1
    const address = `0x${safeCounter.toString(16).padStart(40, '0')}`
    return [{ id: `11111111-1111-4111-8111-${safeCounter.toString().padStart(12, '0')}`, safe_address: address, chain_id: 8453, name: 'Base account' }]
  }

  function get(query = '') {
    const token = app.jwt.sign({ sub: 'user-1', email: 'test@example.com' }, { expiresIn: '1h' })
    return app.inject({
      method: 'GET',
      url: `/transactions${query}`,
      headers: { authorization: `Bearer ${token}` },
    })
  }

  it('reports truncated when a leg comes back holding exactly the window', async () => {
    stubNativeRows(EXPLORER_PAGE_SIZE)
    routeDbQueries(uniqueSafe())

    const response = await get('?fresh=1')

    expect(response.statusCode).toBe(200)
    expect(response.json().truncated).toBe(true)
  })

  it('does not report truncated one row below the window', async () => {
    stubNativeRows(EXPLORER_PAGE_SIZE - 1)
    routeDbQueries(uniqueSafe())

    const response = await get('?fresh=1')

    expect(response.json().truncated).toBe(false)
  })

  it('does not report truncated for an account with no history', async () => {
    stubNativeRows(0)
    routeDbQueries(uniqueSafe())

    const response = await get('?fresh=1')

    expect(response.json().truncated).toBe(false)
  })

  it('reports truncated: false when the user has no accounts at all', async () => {
    stubNativeRows(0)
    routeDbQueries([])

    const response = await get('?fresh=1')

    expect(response.json()).toMatchObject({ truncated: false, total: 0 })
  })

  it('keeps the flag across a cache hit', async () => {
    // The second read is served from the per-account cache. If the flag did
    // not ride with the rows, this is where a capped read would start
    // reporting itself as complete.
    const safes = uniqueSafe()
    stubNativeRows(EXPLORER_PAGE_SIZE)
    routeDbQueries(safes)

    const first = await get('?fresh=1')
    expect(first.json().truncated).toBe(true)

    const second = await get()
    expect(second.json().truncated).toBe(true)
  })

  it('is independent of partialFailure', async () => {
    stubNativeRows(EXPLORER_PAGE_SIZE)
    routeDbQueries(uniqueSafe())

    const response = await get('?fresh=1')

    expect(response.json().truncated).toBe(true)
    expect(response.json().partialFailure).toBe(false)
  })
})
