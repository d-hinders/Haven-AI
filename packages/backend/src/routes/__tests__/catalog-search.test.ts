/**
 * Real-Postgres proof for catalog search (#3250). The claim is about SQL
 * boolean structure, so a mocked query string cannot prove it: every word
 * must match some operator field, while merchant metadata stays outside the
 * search surface.
 */
import Fastify, { FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import { findOrCreateMerchantByHost } from '../../infra/repositories/merchants.js'
import catalogRoutes from '../catalog.js'
import { installRequestValidation } from '../../openapi/request-validation.js'

async function insertOffer(
  merchantId: string,
  name: string,
  description: string,
  category: string,
  resourceUrl: string,
): Promise<void> {
  await db.query(
    `INSERT INTO merchant_catalog
       (name, description, category, resource_url, rail, protocol, tool_name, network, status, verified_at, merchant_id)
     VALUES ($1, $2, $3, $4, 'x402', 'http', NULL, 'eip155:8453', 'active', now(), $5)`,
    [name, description, category, resourceUrl, merchantId],
  )
}

describeDb('catalog multi-word search (#3250)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/catalog.ts'] })
    await app.register(catalogRoutes, { prefix: '/catalog' })
  })

  beforeEach(async () => {
    await resetDb()
    const merchant = await findOrCreateMerchantByHost('catalog-search.example', { name: 'Merchant-only needle' })
    await insertOffer(merchant.id, 'Ampersend Fun', 'A fresh joke on demand', 'entertainment', 'https://catalog-search.example/ampersend-joke')
    await insertOffer(merchant.id, 'Joke', 'A generic laugh', 'entertainment', 'https://catalog-search.example/joke')
  })

  afterAll(async () => {
    await app.close()
    await assertWorkerSchemaAtHead()
  })

  function headers(): Record<string, string> {
    return { authorization: `Bearer ${app.jwt.sign({ sub: 'usr-1', email: 'u@test.dev' })}` }
  }

  it('requires every normalized word across operator name, description, or category, but never merchant name', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/catalog?search=%20%20ampersend%20%20%20joke%20',
      headers: headers(),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().entries.map((entry: { name: string }) => entry.name)).toEqual(['Ampersend Fun'])

    const oneWord = await app.inject({ method: 'GET', url: '/catalog?search=joke', headers: headers() })
    expect(oneWord.statusCode).toBe(200)
    expect(oneWord.json().entries.map((entry: { name: string }) => entry.name)).toEqual(['Ampersend Fun', 'Joke'])

    const everyWordRequired = await app.inject({
      method: 'GET',
      url: '/catalog?search=ampersend%20weather',
      headers: headers(),
    })
    expect(everyWordRequired.statusCode).toBe(200)
    expect(everyWordRequired.json()).toEqual({ entries: [] })

    const merchantOnly = await app.inject({
      method: 'GET',
      url: '/catalog?search=merchant-only%20needle',
      headers: headers(),
    })
    expect(merchantOnly.statusCode).toBe(200)
    expect(merchantOnly.json()).toEqual({ entries: [] })
  })
})
