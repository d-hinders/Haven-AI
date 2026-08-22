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

  it('returns 429 when the pending queue is at its cap', async () => {
    primeSubmitDb({ count: 1_000_000 })

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
