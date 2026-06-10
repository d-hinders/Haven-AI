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
  price_display: '$0.01 USDC',
  price_atomic: '10000',
  asset: 'USDC',
  network: 'eip155:8453',
  status: 'active',
  verified_at: '2026-06-10T00:00:00.000Z',
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-10T00:00:00.000Z',
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
    mockQuery.mockResolvedValue({ rows: [ENTRY] })
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
    expect(String(sql)).toContain('category = $1')
    expect(String(sql)).toContain('rail = $2')
    expect(values).toEqual(['media', 'x402'])
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
    mockQuery.mockResolvedValueOnce({ rows: [ENTRY] })
    const token = app.jwt.sign({ sub: 'usr-1', email: 'u@test.dev' })

    const hit = await app.inject({
      method: 'GET',
      url: '/catalog/cat-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(hit.statusCode).toBe(200)
    expect(hit.json().id).toBe('cat-1')

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
      expect(String(sql)).toContain(`status != 'delisted'`)
    }
  })
})
