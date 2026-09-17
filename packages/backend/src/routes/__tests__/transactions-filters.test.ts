import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import transactionRoutes from '../transactions.js'
import pool from '../../db.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'

/**
 * `GET /transactions/filters` — the envelope key (#2914 follow-up).
 *
 * This route had NO request-level test, and that is exactly how its `safes`
 * key survived #2914's contraction: the slice removed the retired names from
 * the shapes it had tests for. Independent review found the field by reading
 * the spec, not by running anything.
 *
 * So the point of this file is the envelope key itself, asserted through a
 * real request. `toEqual` on the top-level keys is deliberate — a twin added
 * "just for one release" fails here rather than passing a `toMatchObject`.
 */
const ACCOUNT_ADDRESS = '0x135a9215604711AC70d970e12Caa812c53537EF4'
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111'

describe('GET /transactions/filters', () => {
  let app: FastifyInstance

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

  function signToken(sub: string): string {
    return app.jwt.sign({ sub, email: `${sub}@example.com` }, { expiresIn: '1h' })
  }

  /** No explorer reachable — the token collection logs and continues, which
   *  keeps this test about the envelope rather than about chain data. */
  function stubNoExplorer(): void {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('explorer unavailable')
    }))
  }

  function mockAccounts(): void {
    vi.spyOn(pool, 'query').mockImplementation(async (sql: unknown) => {
      const text = String(sql)
      if (text.includes('FROM smart_accounts')) {
        return {
          rows: [{ id: ACCOUNT_ID, account_address: ACCOUNT_ADDRESS, chain_id: 8453, name: 'Main' }],
        } as never
      }
      return { rows: [] } as never
    })
  }

  it('names the account list `accounts`, and carries no `safes` twin', async () => {
    mockAccounts()
    stubNoExplorer()

    const res = await app.inject({
      method: 'GET',
      url: '/transactions/filters',
      headers: { authorization: `Bearer ${signToken('filters-user')}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Object.keys(body).sort()).toEqual(['accounts', 'agents', 'tokens'])
    expect(body.safes).toBeUndefined()
    expect(body.accounts).toEqual([
      { id: ACCOUNT_ID, name: 'Main', address: ACCOUNT_ADDRESS, chainId: 8453 },
    ])
  })

  it('matches the documented shape', async () => {
    mockAccounts()
    stubNoExplorer()

    const res = await app.inject({
      method: 'GET',
      url: '/transactions/filters',
      headers: { authorization: `Bearer ${signToken('filters-spec-user')}` },
    })

    expect(res.statusCode).toBe(200)
    expectMatchesSpec('GET', '/transactions/filters', res.json())
  })

  it('refuses an unauthenticated caller', async () => {
    const res = await app.inject({ method: 'GET', url: '/transactions/filters' })
    expect(res.statusCode).toBe(401)
  })
})
