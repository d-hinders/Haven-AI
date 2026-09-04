import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import discoveryRoutes, { buildDiscoveryDocument } from '../routes/discovery.js'
import { openapiSpec } from '../openapi/spec.js'

/**
 * `GET /discovery` (#2531).
 *
 * The public facts an agent's CODE needs. The test that matters most is the
 * key enumeration: this route re-serves values that are already public, and
 * the only way that stays true is if adding a key is a decision somebody makes
 * rather than something that drifts in.
 */

vi.mock('../domain/chains.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../domain/chains.js')>()),
}))

function req(headers: Record<string, string> = { host: 'api.test' }) {
  return { headers, url: '/discovery', raw: { url: '/discovery' } } as never
}

describe('GET /discovery', () => {
  it('exposes EXACTLY the documented keys, and nothing else', () => {
    // The guard that keeps "nothing not already public elsewhere" true. A new
    // key here fails until someone adds it deliberately — and has to justify
    // it against the list below.
    const doc = buildDiscoveryDocument(req()) as unknown as Record<string, unknown>
    const allowed = ['hosted_mcp_url', 'hosted_mcp_note', 'connector_package', 'openapi_url', 'chains']
    for (const key of Object.keys(doc)) {
      expect(allowed, `unexpected key ${key}`).toContain(key)
    }
    expect(Object.keys(doc)).toContain('connector_package')
    expect(Object.keys(doc)).toContain('chains')
  })

  it('leaks nothing per-user, per-agent, or operational', () => {
    // Named explicitly rather than left to the allow-list, because these are
    // the categories the issue forbids and a reader should see them refused.
    const serialized = JSON.stringify(buildDiscoveryDocument(req()))
    for (const forbidden of ['user', 'agent_id', 'relayer', 'database', 'db', 'secret', 'key_hash', 'balance']) {
      expect(serialized.toLowerCase(), forbidden).not.toContain(forbidden)
    }
  })

  it('reports a missing hosted MCP instead of refusing the whole document', () => {
    // `hostedMcpUrl` throws for a non-production backend with no
    // HAVEN_HOSTED_MCP_URL — right for a connect handout, which must not
    // invent another environment's URL, wrong here: a discovery document that
    // 500s tells an agent nothing.
    const doc = buildDiscoveryDocument(req({ host: 'localhost:3001' }))
    expect(doc.hosted_mcp_url).toBeNull()
    expect(doc.hosted_mcp_note).toMatch(/--local/)
  })

  it('positive control: a production host DOES resolve a hosted MCP url', () => {
    // Without this, the null above could mean the resolver is simply broken.
    process.env.HAVEN_API_URL = 'https://havenbackend-production-8a00.up.railway.app'
    try {
      const doc = buildDiscoveryDocument(req({ host: 'havenbackend-production-8a00.up.railway.app' }))
      expect(doc.hosted_mcp_url).toMatch(/^https:\/\//)
      expect(doc.hosted_mcp_note).toBeUndefined()
    } finally {
      delete process.env.HAVEN_API_URL
    }
  })

  it('derives openapi_url from the request, not a literal', () => {
    const doc = buildDiscoveryDocument(req({ host: 'preview.test', 'x-forwarded-proto': 'https' }))
    expect(doc.openapi_url).toBe('https://preview.test/openapi.json')
  })

  it('answers 200 unauthenticated, and says caches must not share it', async () => {
    const app = Fastify({ logger: false })
    await app.register(discoveryRoutes)
    const res = await app.inject({ method: 'GET', url: '/discovery' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toContain('must-revalidate')
    expect(String(res.headers.vary)).toContain('x-forwarded-host')
    await app.close()
  })

  it('is documented in the spec as a public route', () => {
    const path = (openapiSpec.paths as unknown as Record<string, { get?: { security?: unknown[] } }>)['/discovery']
    expect(path?.get).toBeDefined()
    expect(path?.get?.security).toEqual([])
  })

  it('the spec schema and the real document agree on their keys', () => {
    // The #1446 lesson: assert the real payload against the schema, not the
    // schema against itself.
    const schema = (openapiSpec.components.schemas as unknown as Record<string, { properties: Record<string, unknown> }>)
      .DiscoveryDocument
    const doc = buildDiscoveryDocument(req()) as unknown as Record<string, unknown>
    for (const key of Object.keys(doc)) {
      expect(schema.properties, `spec is missing ${key}`).toHaveProperty(key)
    }
  })
})
