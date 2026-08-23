import Fastify, { FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import pool from '../../db.js'
import catalogSubmissionRoutes from '../catalog-submissions.js'
import { rateLimitKeyFor } from '../../middleware/rate-limit.js'

const mockQuery = vi.spyOn(pool, 'query')

const HOST = 'mcp.example.com'
const RESOURCE_URL = 'https://mcp.example.com/service'

function pendingRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    hostname: HOST,
    resource_url: RESOURCE_URL,
    status: 'submitted',
    submitter_ip: '127.0.0.1',
    verify_token: 'a'.repeat(48),
    created_at: '2026-08-22T00:00:00.000Z',
    updated_at: '2026-08-22T00:00:00.000Z',
    ...overrides,
  }
}

/** SQL-content routing (ship-playbooks/backend.md, #775): NEVER positional. */
function primeSubmitDb(state: {
  existing?: Array<Record<string, unknown>>
  count?: number
  inserted?: Array<Record<string, unknown>>
}) {
  mockQuery.mockImplementation(
    (async (sql: unknown) => {
      const text = String(sql)
      if (text.includes('INSERT INTO catalog_submissions')) {
        return { rows: state.inserted ? [...state.inserted] : [] }
      }
      // The pending count also contains `FROM catalog_submissions` — check the
      // COUNT first so the cap query is not swallowed by the row branch.
      if (text.includes('COUNT(*)')) {
        return { rows: [{ pending: state.count ?? 0 }] }
      }
      if (text.includes('FROM catalog_submissions')) {
        return { rows: state.existing ? [...state.existing] : [] }
      }
      return { rows: [] }
    }) as never,
  )
}

function insertCall(): { sql: string; params: unknown[] } | undefined {
  const call = mockQuery.mock.calls.find(([sql]) =>
    String(sql).includes('INSERT INTO catalog_submissions'),
  )
  if (!call) return undefined
  return { sql: String(call[0]), params: call[1] as unknown[] }
}

describe('catalog /submit (epic #1717 #1711)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(catalogSubmissionRoutes, { prefix: '/catalog' })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockClear()
  })

  it('writes a queue row (normalized host, https url) and returns id + verify_token', async () => {
    primeSubmitDb({
      inserted: [
        {
          id: '00000000-0000-4000-8000-000000000002',
          verify_token: 'b'.repeat(48),
          status: 'submitted',
        },
      ],
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({} as Response)

    const response = await app.inject({
      method: 'POST',
      url: '/catalog/submit',
      payload: { resource_url: 'HTTPS://MCP.EXAMPLE.COM/service' },
    })

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body).toMatchObject({
      id: '00000000-0000-4000-8000-000000000002',
      verify_token: expect.stringMatching(/^[0-9a-f]{48}$/),
      status: 'submitted',
    })

    const insert = insertCall()
    expect(insert).toBeDefined()
    // Hostname normalized to lowercase; the https URL preserved verbatim.
    expect(insert!.params[0]).toBe('mcp.example.com')
    expect(insert!.params[1]).toBe('https://mcp.example.com/service')
    // Submitter metadata: the client IP.
    expect(insert!.params[2]).toBe('127.0.0.1')
    // verify_token: 48 hex chars.
    expect(String(insert!.params[3])).toMatch(/^[0-9a-f]{48}$/)

    // Acceptance: NO outbound request of any kind on the submit path.
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('returns the existing pending submission for the same host (no-op, same id)', async () => {
    primeSubmitDb({ existing: [pendingRow()] })

    const response = await app.inject({
      method: 'POST',
      url: '/catalog/submit',
      payload: { resource_url: RESOURCE_URL },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      id: pendingRow().id,
      verify_token: 'a'.repeat(48),
      status: 'submitted',
    })
    // No new insert: dedupe short-circuits before the cap check and the write.
    expect(insertCall()).toBeUndefined()
  })

  // The cap is asserted AT ITS BOUNDARY, not with an absurd count. A test that
  // primes 1_000_000 pending rows passes for any cap value at all — including a
  // cap raised to 100_000 by accident — so it proves the 429 exists but not
  // that the ceiling is where it claims to be.
  it('admits the last submission below the cap (499 pending)', async () => {
    primeSubmitDb({
      count: 499,
      inserted: [{ id: 'id-under-cap', verify_token: 'c'.repeat(48), status: 'submitted' }],
    })

    const response = await app.inject({
      method: 'POST',
      url: '/catalog/submit',
      payload: { resource_url: RESOURCE_URL },
    })

    expect(response.statusCode).toBe(201)
    expect(insertCall()).toBeDefined()
  })

  it('returns 429 exactly at the cap (500 pending) and writes nothing', async () => {
    primeSubmitDb({ count: 500 })

    const response = await app.inject({
      method: 'POST',
      url: '/catalog/submit',
      payload: { resource_url: RESOURCE_URL },
    })

    expect(response.statusCode).toBe(429)
    expect(response.json().error).toMatch(/queue is full/i)
    expect(insertCall()).toBeUndefined()
  })

  it('rejects invalid input with 400 without touching the queue', async () => {
    const cases: Array<{ payload: Record<string, unknown>; fragment: string }> = [
      { payload: {}, fragment: 'resource_url is required' },
      { payload: { resource_url: 'not-a-url' }, fragment: 'valid https URL' },
      { payload: { resource_url: 'http://mcp.example.com/x' }, fragment: 'https' },
      { payload: { resource_url: 'https://localhost/x' }, fragment: 'public hostname' },
      { payload: { resource_url: 'https://127.0.0.1/x' }, fragment: 'public hostname' },
      { payload: { resource_url: 'https://[::1]/x' }, fragment: 'public hostname' },
      { payload: { resource_url: 42 }, fragment: 'must be a string' },
    ]

    for (const { payload, fragment } of cases) {
      mockQuery.mockClear()
      primeSubmitDb({})
      const response = await app.inject({
        method: 'POST',
        url: '/catalog/submit',
        payload,
      })
      expect(response.statusCode).toBe(400)
      expect(String(response.json().error)).toMatch(new RegExp(fragment, 'i'))
      expect(insertCall()).toBeUndefined()
      expect(mockQuery).not.toHaveBeenCalled()
    }
  })

  // Each case below is a host that LOOKS acceptable to a naive filter. They are
  // named individually so a mutation to one branch of `isLocallyBoundHost`
  // fails a specific assertion instead of a shapeless loop.
  it.each([
    // `new URL()` rewrites this to `[::ffff:7f00:1]`, which matches none of the
    // textual IPv6 prefixes — it walked straight through before `mappedIpv4`.
    ['IPv4-mapped IPv6 loopback', 'https://[::ffff:127.0.0.1]/x'],
    // Hex-literal loopback: URL normalizes it to 127.0.0.1 for us.
    ['hex-literal loopback', 'https://0x7f000001/x'],
    ['IPv4-mapped link-local metadata', 'https://[::ffff:169.254.169.254]/latest/meta-data'],
    ['bare link-local metadata', 'https://169.254.169.254/latest/meta-data'],
    ['unspecified v4', 'https://0.0.0.0/x'],
  ])('refuses a locally-bound host: %s', async (_label, resourceUrl) => {
    primeSubmitDb({})

    const response = await app.inject({
      method: 'POST',
      url: '/catalog/submit',
      payload: { resource_url: resourceUrl },
    })

    expect(response.statusCode).toBe(400)
    expect(String(response.json().error)).toMatch(/public hostname/i)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  // The counterpart to the case above: 169.254/16 is the metadata range, but
  // 169/8 is ordinary public space. Blocking the whole /8 would silently
  // refuse legitimate merchants, so the narrowing is pinned from both sides.
  it('accepts a public 169.x host that is not link-local', async () => {
    primeSubmitDb({
      inserted: [{ id: 'id-169', verify_token: 'd'.repeat(48), status: 'submitted' }],
    })

    const response = await app.inject({
      method: 'POST',
      url: '/catalog/submit',
      payload: { resource_url: 'https://169.99.99.99/service' },
    })

    expect(response.statusCode).toBe(201)
    expect(insertCall()!.params[0]).toBe('169.99.99.99')
  })

  it.each([
    ['basic-auth credentials', 'https://user:pass@mcp.example.com/x'],
    ['username-only display spoof', 'https://attacker.example.com@victim.example.com/p'],
  ])('refuses embedded credentials in resource_url: %s', async (_label, resourceUrl) => {
    primeSubmitDb({})

    const response = await app.inject({
      method: 'POST',
      url: '/catalog/submit',
      payload: { resource_url: resourceUrl },
    })

    expect(response.statusCode).toBe(400)
    expect(String(response.json().error)).toMatch(/embedded credentials/i)
    // Nothing persisted: the credential never reaches the database, so #1713's
    // probe can never replay it as Basic auth.
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('refuses a body above the size ceiling without parsing it', async () => {
    primeSubmitDb({})

    const response = await app.inject({
      method: 'POST',
      url: '/catalog/submit',
      payload: { resource_url: RESOURCE_URL, filler: 'A'.repeat(16 * 1024) },
    })

    expect(response.statusCode).toBe(413)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('drops honeypot-filling bots with a fake success and never touches the queue', async () => {
    primeSubmitDb({})

    const response = await app.inject({
      method: 'POST',
      url: '/catalog/submit',
      payload: { resource_url: RESOURCE_URL, website: 'https://spam.example.com' },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      id: expect.any(String),
      verify_token: expect.any(String),
      status: 'submitted',
    })
    // No SELECT, no COUNT, no INSERT — the request path is a pure drop.
    expect(mockQuery).not.toHaveBeenCalled()
  })
})

describe('catalog /submit rate-limit tier (epic #1717 #1711)', () => {
  let armedApp: FastifyInstance

  beforeAll(async () => {
    armedApp = Fastify({ logger: false })
    await armedApp.register(rateLimit, {
      global: false,
      keyGenerator: (request: { headers: Record<string, string | string[] | undefined>; ip: string }) =>
        rateLimitKeyFor(request),
    })
    // trustProxyHops: 1 arms the tier; without it the tier refuses to arm
    // (untrusted-proxy shared-bucket DoS, #1670/#1711).
    await armedApp.register(catalogSubmissionRoutes, {
      prefix: '/catalog',
      trustProxyHops: 1,
    })
    await armedApp.ready()
  })

  afterAll(async () => {
    await armedApp.close()
  })

  it('429s the 11th request per IP in a minute when armed', async () => {
    // The first SELECT would normally be answered; the point here is the
    // limiter, so every request observes the same empty dedupe result.
    primeSubmitDb({ count: 0 })

    let last: number | undefined
    for (let i = 0; i < 11; i += 1) {
      const response = await armedApp.inject({
        method: 'POST',
        url: '/catalog/submit',
        payload: { resource_url: `https://mcp${i}.example.com/x` },
      })
      last = response.statusCode
    }

    expect(last).toBe(429)
  })
})
