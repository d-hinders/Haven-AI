/**
 * Real-Postgres route tests for `GET /merchants` and `GET /merchants/{slug}`
 * (#3078, epic #3077 decisions 4, 11, 12). No mocks — the claims are about
 * what the SQL returns to WHICH caller:
 *
 *  - a credential-less reader and a dashboard user see the chains the
 *    marketplace lists; the offers on a merchant page come in the public
 *    catalog shape for the former and the full shape for the latter;
 *  - an agent sees ITS OWN chain, whatever the marketplace lists;
 *  - prospects are listed only to a dashboard user, only with the flag on,
 *    only on a testnet-only list — and their page is a 404 to everyone else;
 *  - every 200 matches the spec, and a slug the spec rejects is a 404.
 */
import Fastify, { FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { createHash } from 'crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../db.js'
import { config } from '../../config.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import { findOrCreateMerchantByHost } from '../../infra/repositories/merchants.js'
import merchantRoutes from '../merchants.js'
import catalogRoutes from '../catalog.js'

const AGENT_KEY = 'sk_agent_test_merchants'
const AGENT_KEY_HASH = createHash('sha256').update(AGENT_KEY).digest('hex')

const original = {
  marketplaceChainIds: config.marketplaceChainIds,
  deployChainIds: config.deployChainIds,
  marketplaceProspectsEnabled: config.marketplaceProspectsEnabled,
}

function setConfig(over: Partial<typeof original>): void {
  Object.assign(config, over)
}

let seq = 0

async function seedUser(): Promise<string> {
  seq += 1
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`merchants-${seq}-${Date.now()}@test.example`],
  )
  return rows[0].id
}

/** An agent on `chainId` whose key is AGENT_KEY. */
async function seedAgent(chainId: number): Promise<{ userId: string; agentId: string }> {
  const userId = await seedUser()
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid') RETURNING id`,
    [userId, '0x' + 'cd'.repeat(20), chainId],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, description, delegate_address, api_key_hash, api_key_prefix, account_id, status)
     VALUES ($1, 'a', null, $2, $3, 'sk_agent_tst', $4, 'active') RETURNING id`,
    [userId, '0x' + 'ab'.repeat(20), AGENT_KEY_HASH, account.rows[0].id],
  )
  return { userId, agentId: agent.rows[0].id }
}

async function insertOffer(merchantId: string, resourceUrl: string, network: string, verified = true): Promise<void> {
  seq += 1
  await db.query(
    `INSERT INTO merchant_catalog
       (name, description, category, resource_url, rail, protocol, tool_name, network, status, verified_at, merchant_id)
     VALUES ($1, 'x', 'api', $2, 'x402', 'http', NULL, $3, 'active', $4, $5)`,
    [`offer-${seq}`, resourceUrl, network, verified ? new Date().toISOString() : null, merchantId],
  )
}

async function insertProspect(slug: string): Promise<void> {
  await db.query(
    `INSERT INTO merchants (slug, name, description, listing_status) VALUES ($1, $2, 'A company we are talking to.', 'coming_soon')`,
    [slug, slug],
  )
}

/** The fixture every test starts from: one merchant per chain, one on both, one prospect. */
async function seedMarketplace(): Promise<void> {
  const base = await findOrCreateMerchantByHost('base.example', { name: 'Base only' })
  await insertOffer(base.id, 'https://base.example/a', 'eip155:8453')
  const sepolia = await findOrCreateMerchantByHost('sepolia.example', { name: 'Sepolia only' })
  await insertOffer(sepolia.id, 'https://sepolia.example/a', 'eip155:84532')
  const both = await findOrCreateMerchantByHost('both.example', { name: 'Both chains' })
  await insertOffer(both.id, 'https://both.example/a', 'eip155:8453')
  await insertOffer(both.id, 'https://both.example/b', 'eip155:84532')
  await insertProspect('berget-ai')
}

describeDb('merchants routes (#3078)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(merchantRoutes, { prefix: '/merchants' })
    await app.register(catalogRoutes, { prefix: '/catalog' })
  })
  beforeEach(async () => {
    await resetDb()
    await seedMarketplace()
  })
  afterEach(() => {
    setConfig(original)
  })
  afterAll(async () => {
    await app.close()
    await assertWorkerSchemaAtHead()
  })

  function dashboardHeaders(): Record<string, string> {
    return { authorization: `Bearer ${app.jwt.sign({ sub: 'usr-1', email: 'u@test.dev' })}` }
  }

  const slugsOf = (body: { merchants: Array<{ slug: string }> }) => body.merchants.map((m) => m.slug)

  it('lists the merchants on the listed chains to a credential-less reader, and matches the spec', async () => {
    setConfig({ marketplaceChainIds: [8453], deployChainIds: [] })
    const res = await app.inject({ method: 'GET', url: '/merchants' })
    expect(res.statusCode).toBe(200)
    expectMatchesSpec('GET', '/merchants', res.json())
    expect(slugsOf(res.json())).toEqual(['base-only', 'both-chains'])
    const both = res.json().merchants.find((m: { slug: string }) => m.slug === 'both-chains')
    expect(both).toMatchObject({ offer_count: 1, networks: ['eip155:8453'], listing_status: 'live' })
  })

  it('dev lists both chains (decision 11): every live merchant, network chips per chain', async () => {
    setConfig({ marketplaceChainIds: [84532, 8453], deployChainIds: [] })
    const res = await app.inject({ method: 'GET', url: '/merchants', headers: dashboardHeaders() })
    expect(slugsOf(res.json())).toEqual(['base-only', 'both-chains', 'sepolia-only'])
    const both = res.json().merchants.find((m: { slug: string }) => m.slug === 'both-chains')
    expect(both.offer_count).toBe(2)
    expect([...both.networks].sort()).toEqual(['eip155:8453', 'eip155:84532'])
  })

  it('falls back to the deploy list, then to every chain', async () => {
    setConfig({ marketplaceChainIds: [], deployChainIds: [84532] })
    expect(slugsOf((await app.inject({ method: 'GET', url: '/merchants' })).json())).toEqual(['both-chains', 'sepolia-only'])
    setConfig({ marketplaceChainIds: [], deployChainIds: [] })
    expect(slugsOf((await app.inject({ method: 'GET', url: '/merchants' })).json())).toEqual([
      'base-only',
      'both-chains',
      'sepolia-only',
    ])
  })

  it('serves a merchant page: full offers to a dashboard user, the public shape to a credential-less reader, a 404 off the listed chains', async () => {
    setConfig({ marketplaceChainIds: [8453], deployChainIds: [] })
    const full = await app.inject({ method: 'GET', url: '/merchants/both-chains', headers: dashboardHeaders() })
    expect(full.statusCode).toBe(200)
    expectMatchesSpec('GET', '/merchants/{slug}', full.json())
    expect(full.json().merchant.slug).toBe('both-chains')
    expect(full.json().offers.map((o: { network: string }) => o.network)).toEqual(['eip155:8453'])
    expect(full.json().offers[0]).toHaveProperty('resource_url')
    expect(full.json().offers[0].merchant).toMatchObject({ slug: 'both-chains', is_test_merchant: false })

    const pub = await app.inject({ method: 'GET', url: '/merchants/both-chains' })
    expect(pub.statusCode).toBe(200)
    expect(pub.json().offers[0]).not.toHaveProperty('resource_url')
    expect(pub.json().offers[0]).toHaveProperty('endpoint_host', 'both.example')
    expect(pub.json().offers[0].merchant).toMatchObject({ slug: 'both-chains' })

    // Listed nowhere on this deployment → not served either.
    expect((await app.inject({ method: 'GET', url: '/merchants/sepolia-only' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/merchants/nobody' })).statusCode).toBe(404)
    // A slug the spec's pattern rejects never reaches the database.
    expect((await app.inject({ method: 'GET', url: '/merchants/Not%20A%20Slug' })).statusCode).toBe(404)
  })

  it('an agent sees its own chain, whatever the marketplace lists (decision 4, B1)', async () => {
    await seedAgent(84532)
    setConfig({ marketplaceChainIds: [8453], deployChainIds: [] })
    // The LIST honours the agent's chain like the page does (review S2):
    // the Sepolia-only merchant is in the agent's grid though prod lists 8453.
    const list = await app.inject({ method: 'GET', url: '/merchants', headers: { authorization: `Bearer ${AGENT_KEY}` } })
    expect(list.statusCode).toBe(200)
    expect(slugsOf(list.json())).toEqual(['both-chains', 'sepolia-only'])
    expect(list.json().merchants.find((m: { slug: string }) => m.slug === 'both-chains').networks).toEqual(['eip155:84532'])
    const page = await app.inject({
      method: 'GET',
      url: '/merchants/sepolia-only',
      headers: { authorization: `Bearer ${AGENT_KEY}` },
    })
    expect(page.statusCode).toBe(200)
    expect(page.json().offers.map((o: { network: string }) => o.network)).toEqual(['eip155:84532'])
    // The same agent on the catalog: the Sepolia operator rows are there.
    const catalog = await app.inject({ method: 'GET', url: '/catalog', headers: { authorization: `Bearer ${AGENT_KEY}` } })
    expect(catalog.statusCode).toBe(200)
    const networks = new Set(catalog.json().entries.map((e: { network: string }) => e.network))
    expect([...networks]).toEqual(['eip155:84532'])
    // While a dashboard user on the same deployment sees mainnet only.
    const dash = await app.inject({ method: 'GET', url: '/catalog', headers: dashboardHeaders() })
    expect(new Set(dash.json().entries.map((e: { network: string }) => e.network))).toEqual(new Set(['eip155:8453']))
    // GET /catalog/{id} follows the same scope (review S6): a dashboard user
    // on a mainnet-only deployment does not get a Sepolia entry by id; the
    // Sepolia agent does.
    const sepoliaId = (
      await db.query<{ id: string }>(`SELECT id FROM merchant_catalog WHERE resource_url = 'https://sepolia.example/a'`)
    ).rows[0].id
    expect((await app.inject({ method: 'GET', url: `/catalog/${sepoliaId}`, headers: dashboardHeaders() })).statusCode).toBe(404)
    expect(
      (await app.inject({ method: 'GET', url: `/catalog/${sepoliaId}`, headers: { authorization: `Bearer ${AGENT_KEY}` } })).statusCode,
    ).toBe(200)
    // The dashboard user's full shape matches the spec, `merchant` included.
    expectMatchesSpec('GET', '/catalog', dash.json())
    expect(dash.json().entries[0].merchant).toMatchObject({ listing_status: 'live', is_test_merchant: false })
    // And a credential-less reader sees the same chains, in the reduced public
    // shape (#2530 — narrower than the spec's full shape by design) with the merchant.
    const pub = await app.inject({ method: 'GET', url: '/catalog' })
    expect(new Set(pub.json().entries.map((e: { merchant: { slug: string } }) => e.merchant.slug))).toEqual(
      new Set(['base-only', 'both-chains']),
    )
    expect(pub.json().entries[0]).not.toHaveProperty('resource_url')
  })

  it('shows prospects only to a dashboard user with the flag on and a testnet-only list; 404 for everyone else (decision 12)', async () => {
    setConfig({ marketplaceProspectsEnabled: true, marketplaceChainIds: [84532], deployChainIds: [] })
    const dash = await app.inject({ method: 'GET', url: '/merchants', headers: dashboardHeaders() })
    expect(slugsOf(dash.json())).toContain('berget-ai')
    expect(dash.json().merchants.find((m: { slug: string }) => m.slug === 'berget-ai')).toMatchObject({
      listing_status: 'coming_soon',
      offer_count: 0,
    })
    expectMatchesSpec('GET', '/merchants', dash.json())
    const page = await app.inject({ method: 'GET', url: '/merchants/berget-ai', headers: dashboardHeaders() })
    expect(page.statusCode).toBe(200)
    expect(page.json().offers).toEqual([])

    // A credential-less reader: not listed, page 404.
    expect(slugsOf((await app.inject({ method: 'GET', url: '/merchants' })).json())).not.toContain('berget-ai')
    expect((await app.inject({ method: 'GET', url: '/merchants/berget-ai' })).statusCode).toBe(404)

    // An agent: not listed, page 404.
    await seedAgent(84532)
    const agentHeaders = { authorization: `Bearer ${AGENT_KEY}` }
    expect(slugsOf((await app.inject({ method: 'GET', url: '/merchants', headers: agentHeaders })).json())).not.toContain('berget-ai')
    expect((await app.inject({ method: 'GET', url: '/merchants/berget-ai', headers: agentHeaders })).statusCode).toBe(404)

    // Flag off: gone for the dashboard user too.
    setConfig({ marketplaceProspectsEnabled: false })
    expect(slugsOf((await app.inject({ method: 'GET', url: '/merchants', headers: dashboardHeaders() })).json())).not.toContain('berget-ai')
    expect((await app.inject({ method: 'GET', url: '/merchants/berget-ai', headers: dashboardHeaders() })).statusCode).toBe(404)

    // Flag on but a mainnet listed (a copied env on prod): still gone.
    setConfig({ marketplaceProspectsEnabled: true, marketplaceChainIds: [8453] })
    expect(slugsOf((await app.inject({ method: 'GET', url: '/merchants', headers: dashboardHeaders() })).json())).not.toContain('berget-ai')
    expect((await app.inject({ method: 'GET', url: '/merchants/berget-ai', headers: dashboardHeaders() })).statusCode).toBe(404)
  })
})
