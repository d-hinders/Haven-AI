/**
 * `PUT/GET/POST /merchant-catalogue*` (#4899, epic #4885), on the REAL
 * Postgres harness.
 *
 * The document fetch is mocked at the guard seam (`safeGetText`), so no test
 * touches the network; the address POLICY (`assertSafeUrl`) stays real, because
 * the refusal it produces is part of what the route promises. Everything else
 * is real: the migration, the repository SQL, the enforced request schema and
 * the response shape against the OpenAPI spec.
 *
 * What is pinned:
 *
 * 1. An address Haven would refuse to read is refused at the field, with the
 *    guard's own reason, and nothing is stored.
 * 2. Saving a good address reads it immediately, so the answer is the catalogue
 *    the document produced.
 * 3. A read that fails does not fail the save: the address is stored and the
 *    outcome is recorded.
 * 4. A refresh with no address saved is refused with its own code.
 * 5. A refresh re-reads and the list follows the document.
 * 6. The request body is closed: a body carrying anything but the address is
 *    refused by the schema, before the handler.
 * 7. Every answer matches the OpenAPI spec.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import type { SafeFetchResult } from '../../infra/http/ssrf-guard.js'

const { mockSafeGetText } = vi.hoisted(() => ({ mockSafeGetText: vi.fn() }))

vi.mock('../../infra/http/ssrf-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/http/ssrf-guard.js')>()
  return {
    ...actual,
    safeGetText: (...args: unknown[]) => mockSafeGetText(...args),
  }
})

const merchantCatalogueRoutes = (await import('../merchant-catalogue.js')).default
const { expectMatchesSpec } = await import('../../openapi/response-shape.js')
const { installRequestValidation } = await import('../../openapi/request-validation.js')

const ACCOUNT_ADDRESS = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
const NETWORK = 'eip155:84532'
const DEPLOYMENT = 'https://kit.example.com/'
/** What the save stores: the deployment's origin, path and query dropped. */
const DEPLOYMENT_ORIGIN = 'https://kit.example.com'
/** What the read fetches: the discovery document, and only that path. */
const DISCOVERY_URL = 'https://kit.example.com/.well-known/x402'

function document(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    operator: { name: 'Haven' },
    name: 'Haven inference demo',
    description: 'Opper inference paid per call on Base Sepolia.',
    network: NETWORK,
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    pay_to: ACCOUNT_ADDRESS,
    settlement: { scheme: 'exact', facilitator: 'coinbase-cdp', methods: ['eip3009'] },
    products: [
      {
        id: 'opper-gpt-6-sol-1k',
        name: 'Opper GPT-6 Sol, 1,000 output tokens',
        route: 'POST /v3/compat/chat/completions',
        model: 'openai/gpt-6-sol',
        price: '10000',
        output_token_cap: 1000,
        description: 'One chat completion on openai/gpt-6-sol, up to 1,000 output tokens.',
      },
    ],
    ...overrides,
  })
}

function ok(body: string): SafeFetchResult {
  return { ok: true, status: 200, body, headers: {}, finalUrl: `${DEPLOYMENT}.well-known/x402` }
}

describeDb('the merchant catalogue routes (#4899)', () => {
  let app: FastifyInstance
  let token: string
  let accountId: string

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    // The production wiring: the plugin is registered by the test, the same
    // root-scope install index.ts performs, and the module is enforced.
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/merchant-catalogue.ts'] })
    await app.register(merchantCatalogueRoutes, { prefix: '/merchant-catalogue' })
  })

  afterAll(async () => {
    await app?.close()
  })

  beforeEach(async () => {
    await resetDb()
    mockSafeGetText.mockReset()

    const user = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`catalogue-route-${randomUUID()}@test.example`],
    )
    const account = await db.query<{ id: string }>(
      `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, is_default, is_merchant_account)
       VALUES ($1, $2, 84532, 'delegation', 'delegator_hybrid', false, true) RETURNING id`,
      [user.rows[0].id, ACCOUNT_ADDRESS],
    )
    accountId = account.rows[0].id
    token = app.jwt.sign({ sub: user.rows[0].id, email: 'owner@example.com' })
  })

  function save(body: unknown) {
    return app.inject({
      method: 'PUT',
      url: '/merchant-catalogue/deployment',
      headers: { authorization: `Bearer ${token}` },
      payload: body as Record<string, unknown>,
    })
  }

  function refresh() {
    return app.inject({
      method: 'POST',
      url: '/merchant-catalogue/refresh',
      headers: { authorization: `Bearer ${token}` },
    })
  }

  function read() {
    return app.inject({
      method: 'GET',
      url: '/merchant-catalogue',
      headers: { authorization: `Bearer ${token}` },
    })
  }

  it('refuses an address Haven would not read, with the guard reason, and stores nothing', async () => {
    const literal = await save({ deployment_url: 'https://169.254.169.254/' })
    expect(literal.statusCode, literal.body).toBe(400)
    expect(literal.json()).toMatchObject({
      error_code: 'MERCHANT_CATALOGUE_URL_REFUSED',
      reason: 'host_not_public',
    })
    expectMatchesSpec('PUT', '/merchant-catalogue/deployment', literal.json(), '400')

    const plain = await save({ deployment_url: 'http://kit.example.com/' })
    expect(plain.statusCode).toBe(400)
    expect(plain.json()).toMatchObject({ error_code: 'MERCHANT_CATALOGUE_URL_REFUSED', reason: 'scheme_not_https' })

    const port = await save({ deployment_url: 'https://kit.example.com:8443/' })
    expect(port.statusCode).toBe(400)
    expect(port.json()).toMatchObject({ reason: 'non_default_port' })

    // Nothing was stored and nothing was fetched.
    const rows = await db.query(`SELECT 1 FROM merchant_catalogue_sources WHERE merchant_account_id = $1`, [accountId])
    expect(rows.rows).toHaveLength(0)
    expect(mockSafeGetText).not.toHaveBeenCalled()
  })

  it('saves a good address, reads it immediately, and answers the catalogue it produced', async () => {
    mockSafeGetText.mockResolvedValue(ok(document()))

    const res = await save({ deployment_url: DEPLOYMENT })
    expect(res.statusCode, res.body).toBe(200)
    expectMatchesSpec('PUT', '/merchant-catalogue/deployment', res.json(), '200')

    const body = res.json()
    expect(body).toMatchObject({
      deployment_url: DEPLOYMENT_ORIGIN,
      last_read_status: 'ok',
      mismatch: false,
      document_name: 'Haven inference demo',
      document_operator_name: 'Haven',
      document_network: NETWORK,
      document_pay_to: ACCOUNT_ADDRESS,
    })
    expect(body.last_read_at).not.toBeNull()
    expect(body.products).toEqual([
      {
        product_id: 'opper-gpt-6-sol-1k',
        name: 'Opper GPT-6 Sol, 1,000 output tokens',
        description: 'One chat completion on openai/gpt-6-sol, up to 1,000 output tokens.',
        route: 'POST /v3/compat/chat/completions',
        model: 'openai/gpt-6-sol',
        price_atomic: '10000',
        network: NETWORK,
        output_token_cap: 1000,
        offered: true,
        removed_at: null,
      },
    ])

    // The read went through the guard with the same-host policy, and it fetched
    // the discovery document — not the deployment root, which the proxy 404s.
    expect(mockSafeGetText).toHaveBeenCalledTimes(1)
    expect(mockSafeGetText.mock.calls[0]![0]).toBe(DISCOVERY_URL)
    expect(mockSafeGetText.mock.calls[0]![1]).toMatchObject({ sameHostOnly: true })
  })

  it('stores the deployment origin, so a pasted path cannot become the read', async () => {
    mockSafeGetText.mockResolvedValue(ok(document()))

    const res = await save({ deployment_url: 'https://kit.example.com/foo?bar=1#frag' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ deployment_url: DEPLOYMENT_ORIGIN, last_read_status: 'ok' })
    expect(mockSafeGetText.mock.calls[0]![0]).toBe(DISCOVERY_URL)
  })

  it('stores the address even when the read fails, and records the outcome', async () => {
    mockSafeGetText.mockResolvedValue({ ok: false, reason: 'timeout', detail: 'no answer' })

    const res = await save({ deployment_url: DEPLOYMENT })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({
      deployment_url: DEPLOYMENT_ORIGIN,
      last_read_status: 'unreachable',
      mismatch: false,
      products: [],
    })
    expect(res.json().last_read_at).not.toBeNull()
  })

  it('records a mismatch and does not use the document’s products', async () => {
    mockSafeGetText.mockResolvedValue(ok(document({ pay_to: '0x7a3f9c2e1b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a' })))

    const res = await save({ deployment_url: DEPLOYMENT })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ last_read_status: 'mismatch', mismatch: true, products: [] })
    expect(res.json().mismatch_reason).toContain('receiving address')
  })

  it('refuses a refresh before an address is saved, with its own code', async () => {
    const res = await refresh()
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json()).toMatchObject({ error_code: 'MERCHANT_CATALOGUE_NOT_CONFIGURED' })
    expectMatchesSpec('POST', '/merchant-catalogue/refresh', res.json(), '409')
  })

  it('re-reads on request and the list follows the document', async () => {
    mockSafeGetText.mockResolvedValue(ok(document()))
    await save({ deployment_url: DEPLOYMENT })

    // The merchant adds a product.
    const grown = JSON.parse(document()) as { products: unknown[] }
    grown.products.push({
      id: 'opper-gpt-6-sol-4k',
      name: 'Opper GPT-6 Sol, 4,000 output tokens',
      route: 'POST /v3/compat/chat/completions',
      model: 'openai/gpt-6-sol-4k',
      price: '40000',
      output_token_cap: 4000,
      description: 'One chat completion on openai/gpt-6-sol-4k, up to 4,000 output tokens.',
    })
    mockSafeGetText.mockResolvedValue(ok(JSON.stringify(grown)))

    const res = await refresh()
    expect(res.statusCode, res.body).toBe(200)
    expectMatchesSpec('POST', '/merchant-catalogue/refresh', res.json(), '200')
    expect(res.json().products.map((p: { product_id: string }) => p.product_id)).toEqual([
      'opper-gpt-6-sol-1k',
      'opper-gpt-6-sol-4k',
    ])
  })

  it('answers an empty catalogue for a user who has saved nothing', async () => {
    const res = await read()
    expect(res.statusCode, res.body).toBe(200)
    expectMatchesSpec('GET', '/merchant-catalogue', res.json(), '200')
    expect(res.json()).toMatchObject({
      deployment_url: null,
      last_read_at: null,
      last_read_status: 'never',
      mismatch: false,
      products: [],
    })
  })

  it('refuses a body carrying anything but the address — the schema is closed', async () => {
    const res = await save({ deployment_url: DEPLOYMENT, merchant_account_id: accountId })
    expect(res.statusCode, res.body).toBe(400)
    expect(mockSafeGetText).not.toHaveBeenCalled()
  })

  it('refuses a save with no address at all', async () => {
    const res = await save({})
    expect(res.statusCode, res.body).toBe(400)
    expect(mockSafeGetText).not.toHaveBeenCalled()
  })
})
