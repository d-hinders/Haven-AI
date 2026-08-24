import Fastify, { FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { createHash } from 'crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../../db.js', () => ({
  default: { query: (...args: unknown[]) => mockQuery(...args) },
}))

import catalogRoutes from '../catalog.js'

const AGENT_KEY = 'sk_agent_test_catalog'
const AGENT_KEY_HASH = createHash('sha256').update(AGENT_KEY).digest('hex')

const AGENT_ROW = {
  id: 'agt-1',
  user_id: 'usr-1',
  name: 'Catalog Agent',
  delegate_address: '0x' + 'ab'.repeat(20),
  status: 'active',
  safe_address: '0x' + 'cd'.repeat(20),
  chain_id: 8453,
}

const ENTRY = {
  id: 'cat-1',
  name: 'Soundside — text generation',
  description: 'Generate text content.',
  category: 'media',
  resource_url: 'https://mcp.soundside.ai/mcp',
  rail: 'x402',
  protocol: 'mcp',
  tool_name: 'create_text',
  tool_arguments: { format: 'plain' },
  price_display: '$0.01 USDC',
  price_atomic: '10000',
  asset: 'USDC',
  network: 'eip155:8453',
  asset_transfer_methods: 'eip3009',
  status: 'active',
  verified_at: '2026-06-10T00:00:00.000Z',
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-10T00:00:00.000Z',
}

const VPN_ENTRY = {
  ...ENTRY,
  id: 'cat-vpn-basic',
  name: 'NordShield VPN Basic',
  description: 'Private VPN access for one device.',
  category: 'vpn',
  tool_name: 'buy_vpn',
  tool_arguments: { plan: 'basic' },
}

/**
 * The agent-auth middleware issues its own SELECT before the route handler
 * runs. Route mocks therefore answer the agent lookup first when an agent
 * key is supplied.
 */
function mockAgentLookupThen(...catalogResults: Array<{ rows: unknown[] }>) {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('api_key_hash')) return { rows: [AGENT_ROW] }
    if (sql.includes('UPDATE agents')) return { rows: [] }
    return catalogResults.shift() ?? { rows: [] }
  })
}

/**
 * The listing routes ALSO read verified ingestion rows (#1715). This helper
 * answers the merchant_catalog query with `merchantRows` and the
 * catalog_submissions listing query with `ingestionRows` (empty unless asked),
 * so a test that only cares about operator entries does not accidentally feed
 * the ingestion branch.
 */
function mockCatalogWithIngestion(merchantRows: unknown[], ingestionRows: unknown[] = []) {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('api_key_hash')) return { rows: [AGENT_ROW] }
    if (sql.includes('UPDATE agents')) return { rows: [] }
    if (sql.includes('FROM catalog_submissions')) return { rows: ingestionRows }
    return { rows: merchantRows }
  })
}

describe('catalog routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(catalogRoutes, { prefix: '/catalog' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('rejects unauthenticated requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/catalog' })
    expect(res.statusCode).toBe(401)
  })

  it('lists entries for a dashboard JWT', async () => {
    mockCatalogWithIngestion([ENTRY])
    const token = app.jwt.sign({ sub: 'usr-1', email: 'u@test.dev' })

    const res = await app.inject({
      method: 'GET',
      url: '/catalog',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { entries: Array<Record<string, unknown>> }
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0]).toMatchObject({
      id: 'cat-1',
      rail: 'x402',
      protocol: 'mcp',
      tool_name: 'create_text',
      tool_arguments: { format: 'plain' },
      price_display: '$0.01 USDC',
      status: 'active',
    })
    // internal columns never leak
    expect(body.entries[0]).not.toHaveProperty('created_at')
  })

  it('lists entries for an agent API key', async () => {
    mockAgentLookupThen({ rows: [ENTRY] })

    const res = await app.inject({
      method: 'GET',
      url: '/catalog',
      headers: { authorization: `Bearer ${AGENT_KEY}` },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().entries).toHaveLength(1)
    // agent lookup used the hashed key
    const lookupCall = mockQuery.mock.calls.find(([sql]) => String(sql).includes('api_key_hash'))
    expect(lookupCall?.[1]).toEqual([AGENT_KEY_HASH])
    const catalogCall = mockQuery.mock.calls
      .slice()
      .reverse()
      .find(([sql]) => String(sql).includes('FROM merchant_catalog'))
    expect(String(catalogCall?.[0])).toContain('network = $1')
    expect(catalogCall?.[1]).toEqual(['eip155:8453'])
  })

  it('scopes agent discovery to the agent chain alongside category and rail filters', async () => {
    mockAgentLookupThen({ rows: [ENTRY] })

    const res = await app.inject({
      method: 'GET',
      url: '/catalog?category=storage&rail=x402',
      headers: { authorization: `Bearer ${AGENT_KEY}` },
    })

    expect(res.statusCode).toBe(200)
    const catalogCall = mockQuery.mock.calls
      .slice()
      .reverse()
      .find(([sql]) => String(sql).includes('FROM merchant_catalog'))
    expect(String(catalogCall?.[0])).toContain('LOWER(TRIM(category)) = LOWER(TRIM($1))')
    expect(String(catalogCall?.[0])).toContain('rail = $2')
    expect(String(catalogCall?.[0])).toContain('network = $3')
    expect(catalogCall?.[1]).toEqual(['storage', 'x402', 'eip155:8453'])
  })

  it('filters by category and rail', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const token = app.jwt.sign({ sub: 'usr-1', email: 'u@test.dev' })

    const res = await app.inject({
      method: 'GET',
      url: '/catalog?category=media&rail=x402',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.statusCode).toBe(200)
    const [sql, values] = mockQuery.mock.calls[0]
    expect(String(sql)).toContain('LOWER(TRIM(category)) = LOWER(TRIM($1))')
    expect(String(sql)).toContain('rail = $2')
    expect(String(sql)).not.toContain('network = $3')
    expect(values).toEqual(['media', 'x402'])
  })

  it('matches categories case-insensitively and trims user input', async () => {
    mockQuery.mockResolvedValue({ rows: [VPN_ENTRY] })
    const token = app.jwt.sign({ sub: 'usr-1', email: 'u@test.dev' })

    const res = await app.inject({
      method: 'GET',
      url: '/catalog?category=%20VPN%20',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().entries[0]).toMatchObject({
      id: 'cat-vpn-basic',
      name: 'NordShield VPN Basic',
      category: 'vpn',
    })
    const [sql, values] = mockQuery.mock.calls[0]
    expect(String(sql)).toContain('LOWER(TRIM(category)) = LOWER(TRIM($1))')
    expect(values).toEqual(['VPN'])
  })

  it('searches names, descriptions, and categories without changing read-only scoping', async () => {
    mockAgentLookupThen({ rows: [VPN_ENTRY] })

    const res = await app.inject({
      method: 'GET',
      url: '/catalog?search=NordShield%20VPN%20Basic&rail=x402',
      headers: { authorization: `Bearer ${AGENT_KEY}` },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().entries[0]).toMatchObject({ id: 'cat-vpn-basic', category: 'vpn' })
    const catalogCall = mockQuery.mock.calls
      .slice()
      .reverse()
      .find(([sql]) => String(sql).includes('FROM merchant_catalog'))
    expect(String(catalogCall?.[0])).toContain(
      `(name ILIKE '%' || $2 || '%' OR description ILIKE '%' || $2 || '%' OR category ILIKE '%' || $2 || '%')`,
    )
    expect(String(catalogCall?.[0])).toContain(`rail = $1`)
    expect(String(catalogCall?.[0])).toContain(`network = $3`)
    expect(String(catalogCall?.[0])).toContain(`status != 'delisted'`)
    expect(String(catalogCall?.[0])).toContain('ORDER BY status = \'active\' DESC, category ASC, name ASC, id ASC')
    expect(catalogCall?.[1]).toEqual(['x402', 'NordShield VPN Basic', 'eip155:8453'])
  })

  it('finds a product from a category term search', async () => {
    mockCatalogWithIngestion([VPN_ENTRY])
    const token = app.jwt.sign({ sub: 'usr-1', email: 'u@test.dev' })

    const res = await app.inject({
      method: 'GET',
      url: '/catalog?search=VPN',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().entries).toEqual([
      expect.objectContaining({
        id: 'cat-vpn-basic',
        name: 'NordShield VPN Basic',
        category: 'vpn',
      }),
    ])
    const [sql, values] = mockQuery.mock.calls[0]
    expect(String(sql)).toContain(
      `(name ILIKE '%' || $1 || '%' OR description ILIKE '%' || $1 || '%' OR category ILIKE '%' || $1 || '%')`,
    )
    expect(values).toEqual(['VPN'])
  })

  it('returns an empty result for an unmatched search', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const token = app.jwt.sign({ sub: 'usr-1', email: 'u@test.dev' })

    const res = await app.inject({
      method: 'GET',
      url: '/catalog?search=does-not-exist',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ entries: [] })
  })

  it('rejects malformed category and malformed search filters before querying the catalog', async () => {
    const token = app.jwt.sign({ sub: 'usr-1', email: 'u@test.dev' })

    const repeatedCategory = await app.inject({
      method: 'GET',
      url: '/catalog?category=vpn&category=storage',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(repeatedCategory.statusCode).toBe(400)
    expect(repeatedCategory.json()).toEqual({ error: 'Category must be a single string' })

    mockQuery.mockClear()
    const empty = await app.inject({
      method: 'GET',
      url: '/catalog?search=%20%20',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(empty.statusCode).toBe(400)
    expect(empty.json()).toEqual({ error: 'Search must not be empty' })

    mockQuery.mockClear()
    const repeated = await app.inject({
      method: 'GET',
      url: '/catalog?search=one&search=two',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(repeated.statusCode).toBe(400)
    expect(repeated.json()).toEqual({ error: 'Search must be a single string' })

    mockQuery.mockClear()
    const long = await app.inject({
      method: 'GET',
      url: `/catalog?search=${'x'.repeat(121)}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(long.statusCode).toBe(400)
    expect(long.json()).toEqual({ error: 'Search must be 120 characters or fewer' })
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('rejects an unknown rail filter', async () => {
    const token = app.jwt.sign({ sub: 'usr-1', email: 'u@test.dev' })
    const res = await app.inject({
      method: 'GET',
      url: '/catalog?rail=carrier-pigeon',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns one entry by id and 404s on misses', async () => {
    const token = app.jwt.sign({ sub: 'usr-1', email: 'u@test.dev' })
    mockCatalogWithIngestion([ENTRY])

    const hit = await app.inject({
      method: 'GET',
      url: '/catalog/cat-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(hit.statusCode).toBe(200)
    expect(hit.json().id).toBe('cat-1')

    mockAgentLookupThen({ rows: [ENTRY] })
    const agentHit = await app.inject({
      method: 'GET',
      url: '/catalog/cat-1',
      headers: { authorization: `Bearer ${AGENT_KEY}` },
    })
    expect(agentHit.statusCode).toBe(200)
    const catalogCall = mockQuery.mock.calls
      .slice()
      .reverse()
      .find(([sql]) => String(sql).includes('FROM merchant_catalog'))
    expect(String(catalogCall?.[0])).toContain('network = $2')
    expect(catalogCall?.[1]).toEqual(['cat-1', 'eip155:8453'])

    mockQuery.mockResolvedValueOnce({ rows: [] })
    const miss = await app.inject({
      method: 'GET',
      url: '/catalog/cat-unknown',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(miss.statusCode).toBe(404)
  })

  it('never serves delisted entries', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const token = app.jwt.sign({ sub: 'usr-1', email: 'u@test.dev' })

    await app.inject({
      method: 'GET',
      url: '/catalog',
      headers: { authorization: `Bearer ${token}` },
    })
    await app.inject({
      method: 'GET',
      url: '/catalog/cat-1',
      headers: { authorization: `Bearer ${token}` },
    })

    for (const [sql] of mockQuery.mock.calls) {
      // The ingestion listing query (#1715) selects verified_payable rows only
      // — it has no 'delisted' clause because it cannot contain delisted rows.
      if (String(sql).includes('FROM catalog_submissions')) continue
      expect(String(sql)).toContain(`status != 'delisted'`)
    }
  })

  it('merges verified ingestion entries after operator rows, with badges (#1715)', async () => {
    mockCatalogWithIngestion([ENTRY], [
      {
        id: '00000000-0000-4000-8000-000000000002',
        resource_url: 'https://directory.example.com/mcp',
        name: 'Directory Summarizer',
        description: 'A self-submitted payable service',
        entrypoint: 'summarize',
        last_verified_at: '2026-08-23T10:00:00.000Z',
      },
    ])
    const token = app.jwt.sign({ sub: 'usr-1', email: 'u@test.dev' })

    const res = await app.inject({ method: 'GET', url: '/catalog', headers: { authorization: `Bearer ${token}` } })
    expect(res.statusCode).toBe(200)
    const entries = res.json().entries
    expect(entries).toHaveLength(2)
    // Operator row first, ingestion row second.
    expect(entries[0]).toMatchObject({ id: 'cat-1', source: 'operator', domain_verified: false, verified_payable: false })
    expect(entries[1]).toMatchObject({
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Directory Summarizer',
      source: 'ingestion',
      domain_verified: true,
      verified_payable: true,
      category: 'api',
      rail: 'x402',
      protocol: 'mcp',
      tool_name: 'summarize',
      verified_at: '2026-08-23T10:00:00.000Z',
    })
  })

  it('hides ingestion entries from agents (they filter by chain; ingestion rows have none) and applies the rail filter', async () => {
    mockCatalogWithIngestion([ENTRY], [
      {
        id: '00000000-0000-4000-8000-000000000002',
        resource_url: 'https://directory.example.com/mcp',
        name: 'Directory Summarizer',
        description: 'A self-submitted payable service',
        entrypoint: 'summarize',
        last_verified_at: null,
      },
    ])

    const agentRes = await app.inject({ method: 'GET', url: '/catalog', headers: { authorization: `Bearer ${AGENT_KEY}` } })
    expect(agentRes.json().entries).toHaveLength(1)

    // A 'mpp' filter excludes the x402 ingestion row from the dashboard too.
    const jwt = app.jwt.sign({ sub: 'usr-1', email: 'u@test.dev' })
    const dash = await app.inject({ method: 'GET', url: '/catalog?rail=mpp', headers: { authorization: `Bearer ${jwt}` } })
    expect(dash.json().entries).toHaveLength(1)
  })
})
