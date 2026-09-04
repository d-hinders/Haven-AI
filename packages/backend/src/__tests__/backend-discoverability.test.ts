import Fastify from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { describe, expect, it } from 'vitest'
import { apiBaseUrl } from '../domain/request-origin.js'
import { config } from '../config.js'
import { authMiddleware, OWNER_UNAUTHORIZED_BODY } from '../middleware/auth.js'
import { AGENT_MISSING_KEY_BODY, AGENT_INVALID_KEY_BODY } from '../middleware/agentAuth.js'
import { PUBLIC_CATALOG_FIELDS, toPublicListing, endpointHost } from '../routes/catalog.js'
import { fastifyPathToOpenApi } from '../openapi/route-inventory.js'
import { openapiSpec } from '../openapi/spec.js'

/**
 * Backend discoverability (#2530).
 *
 * An agent handed only a backend URL had nothing to read: `GET /` was a 404,
 * a 401 said `{"error":"Unauthorized"}` and nothing about which credential the
 * door wanted, and the OpenAPI `servers[]` list named the production host even
 * when the dev backend served it. None of this changes what is accepted or
 * refused — only what a refusal and a root document SAY.
 */

describe('request origin', () => {
  function req(headers: Record<string, string>, url = '/openapi.json') {
    return { headers, url, raw: { url } } as never
  }

  it('derives the origin from the request', () => {
    expect(apiBaseUrl(req({ host: 'api.example.test', 'x-forwarded-proto': 'https' }))).toBe(
      'https://api.example.test',
    )
  })

  it('takes the LEFTMOST scheme — the client\'s protocol, not an inner hop\'s', () => {
    // `x-forwarded-proto: https,http` means the client reached the edge over
    // https and an inner hop continued over http. A public URL should name the
    // client's protocol. This is deliberately the opposite selection from the
    // HOST below, which indexes from the trusted end: the host is the
    // spoofable target, the scheme is a semantic.
    expect(apiBaseUrl(req({ host: 'a.test', 'x-forwarded-proto': 'https,http' }))).toBe('https://a.test')
  })

  it('an explicit variable wins over the headers', () => {
    process.env.HAVEN_API_URL = 'https://explicit.test/'
    try {
      expect(apiBaseUrl(req({ host: 'header.test' }))).toBe('https://explicit.test')
    } finally {
      delete process.env.HAVEN_API_URL
    }
  })

  it('prefers x-forwarded-host ONLY when the deployment trusts its proxy', () => {
    // The header is client-supplied. Trusting it unconditionally would let a
    // caller choose the host this service names in its own contract — the same
    // discipline `authRateLimit` applies to `x-forwarded-for` (#1670).
    const headers = { host: 'backend.internal', 'x-forwarded-host': 'preview.test', 'x-forwarded-proto': 'https' }
    const original = config.trustProxyHops
    try {
      ;(config as { trustProxyHops: number }).trustProxyHops = 1
      expect(apiBaseUrl(req(headers))).toBe('https://preview.test')
      ;(config as { trustProxyHops: number }).trustProxyHops = 0
      // The HOST falls back; the scheme does NOT. Gating the scheme too would
      // make every TLS-terminating deployment without TRUST_PROXY_HOPS
      // advertise http:// for its own API — a downgrade hint introduced in the
      // name of security.
      expect(apiBaseUrl(req(headers))).toBe('https://backend.internal')
    } finally {
      ;(config as { trustProxyHops: number }).trustProxyHops = original
    }
  })

  it('an explicit URL is the only way to state a path prefix, and that is deliberate', () => {
    // The frontend proxies `/api/:path*` and its rewrite STRIPS the prefix, so
    // the backend never sees it — measured: `GET /api/openapi.json` against
    // the backend is a 404. A deployment that wants its spec to advertise
    // `https://preview.test/api` states it rather than hoping it is inferred.
    process.env.HAVEN_API_URL = 'https://preview.test/api'
    try {
      expect(apiBaseUrl(req({ host: 'backend.internal' }))).toBe('https://preview.test/api')
    } finally {
      delete process.env.HAVEN_API_URL
    }
  })

    it('SPOOFING: a client-prepended x-forwarded-host loses to the trusted hop', () => {
      // The correction a reviewer forced. Selecting index 0 reads the value an
      // ORIGINAL CLIENT could have written whenever a proxy appends rather than
      // overwrites — precisely the spoofing class the hop count exists to close.
      // `proxy-addr` counts from the right for `x-forwarded-for`; so does this.
      const original = config.trustProxyHops
      try {
        ;(config as { trustProxyHops: number }).trustProxyHops = 1
        expect(
          apiBaseUrl(
            req({
              host: 'backend.internal',
              'x-forwarded-host': 'attacker.example, real-edge.test',
              'x-forwarded-proto': 'https',
            }),
          ),
        ).toBe('https://real-edge.test')
      } finally {
        ;(config as { trustProxyHops: number }).trustProxyHops = original
      }
    })

    it('counts hops from the right, so two trusted hops read two from the end', () => {
      const original = config.trustProxyHops
      try {
        ;(config as { trustProxyHops: number }).trustProxyHops = 2
        expect(
          apiBaseUrl(req({ host: 'b.internal', 'x-forwarded-host': 'attacker.example, edge.test, inner.test' })),
        ).toBe('http://edge.test')
      } finally {
        ;(config as { trustProxyHops: number }).trustProxyHops = original
      }
    })

    it('a repeated header field cannot disagree with a comma chain', () => {
      const original = config.trustProxyHops
      try {
        ;(config as { trustProxyHops: number }).trustProxyHops = 1
        const asArray = { host: 'b.internal', 'x-forwarded-host': ['attacker.example', 'real-edge.test'] }
        expect(apiBaseUrl({ headers: asArray, url: '/', raw: { url: '/' } } as never)).toBe(
          'http://real-edge.test',
        )
      } finally {
        ;(config as { trustProxyHops: number }).trustProxyHops = original
      }
    })
})

describe('401 hints', () => {
  it('keeps the error string every other test asserts, and adds a hint', () => {
    expect(OWNER_UNAUTHORIZED_BODY.error).toBe('Unauthorized')
    expect(AGENT_MISSING_KEY_BODY.error).toBe('Missing or invalid API key')
    expect(AGENT_INVALID_KEY_BODY.error).toBe('Invalid or revoked API key')
    for (const body of [OWNER_UNAUTHORIZED_BODY, AGENT_MISSING_KEY_BODY, AGENT_INVALID_KEY_BODY]) {
      expect(body.hint.length).toBeGreaterThan(20)
    }
  })

  it('names which credential each door wants', () => {
    expect(OWNER_UNAUTHORIZED_BODY.hint).toMatch(/owner session/i)
    expect(AGENT_MISSING_KEY_BODY.hint).toMatch(/sk_agent_/)
  })

  it('#1640: a purpose-scoped token gets a body IDENTICAL to a failed verification', async () => {
    // The rule this change must not break. A purpose-scoped token is refused
    // with the same body as garbage, so which kind of token was presented is
    // not something an unauthenticated caller is told.
    const app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret-for-2530-only' })
    app.get('/guarded', { preHandler: authMiddleware }, async () => ({ ok: true }))

    const garbage = await app.inject({ method: 'GET', url: '/guarded', headers: { authorization: 'Bearer nonsense' } })
    const purposeToken = app.jwt.sign({ sub: 'u1', purpose: 'fortnox_oauth' } as unknown as { sub: string; email: string })
    const scoped = await app.inject({ method: 'GET', url: '/guarded', headers: { authorization: `Bearer ${purposeToken}` } })

    expect(garbage.statusCode).toBe(401)
    expect(scoped.statusCode).toBe(401)
    expect(scoped.body).toBe(garbage.body)
    expect(JSON.parse(scoped.body)).toEqual({ ...OWNER_UNAUTHORIZED_BODY })
    await app.close()
  })

  it('the invalid-key hint does not say WHY the key is unusable', () => {
    // Archived, revoked, unknown-status and no-such-key all share one body on
    // purpose. A hint that distinguished them would put the leak back.
    for (const word of ['revoked', 'archived', 'paused', 'expired', 'deleted']) {
      expect(AGENT_INVALID_KEY_BODY.hint.toLowerCase()).not.toContain(word)
    }
  })
})

describe('public catalogue shape', () => {
  const FULL = {
    id: 'cat_1',
    name: 'Weather API',
    description: 'Forecasts',
    category: 'api',
    resource_url: 'https://merchant.example.test/v1/forecast?key=secret',
    rail: 'x402',
    protocol: 'http',
    tool_name: 'get_forecast',
    tool_arguments: { city: 'string' },
    price_display: '0.01 USDC',
    price_atomic: '10000',
    asset: 'USDC',
    network: 'eip155:8453',
    asset_transfer_methods: 'eip3009',
    status: 'active',
    verified_at: '2026-09-01T00:00:00.000Z',
    source: 'operator',
    domain_verified: false,
    verified_payable: false,
  }

  it('returns exactly the allow-listed fields, no more', () => {
    const publicShape = toPublicListing(FULL)
    expect(Object.keys(publicShape).sort()).toEqual([...PUBLIC_CATALOG_FIELDS].sort())
  })

  it('leaks no field outside the allow-list', () => {
    // The assertion that makes this change reviewable as a list. Any new
    // column on merchant_catalog is excluded by default rather than included.
    const publicShape = toPublicListing(FULL)
    for (const withheld of ['resource_url', 'tool_name', 'tool_arguments', 'price_display', 'price_atomic', 'asset', 'network', 'asset_transfer_methods']) {
      expect(publicShape, withheld).not.toHaveProperty(withheld)
    }
  })

  it('gives the endpoint HOST, never the full callable url with its query', () => {
    const publicShape = toPublicListing(FULL)
    expect(publicShape.endpoint_host).toBe('merchant.example.test')
    expect(JSON.stringify(publicShape)).not.toContain('secret')
    expect(JSON.stringify(publicShape)).not.toContain('/v1/forecast')
  })

  it('positive control: the full shape DOES carry what the public one withholds', () => {
    // If the fixture lacked those fields, the exclusion assertions above would
    // pass against a shape that never had anything to hide.
    expect(FULL).toHaveProperty('resource_url')
    expect(FULL).toHaveProperty('price_atomic')
    expect(FULL.tool_arguments).not.toBeNull()
  })

  it('survives an unparseable resource url instead of throwing', () => {
    expect(endpointHost('not a url')).toBeNull()
    expect(endpointHost(null)).toBeNull()
    expect(toPublicListing({ ...FULL, resource_url: 'nonsense' }).endpoint_host).toBeNull()
  })
})

describe('the root document is a documented route', () => {
  it('normalises a prefix-less root route to "/", not the empty string', () => {
    // The empty string is not a path OpenAPI can express. Nothing exercised
    // this until the root document existed, so the coverage gate reported a
    // registered route as `GET ` that no spec key could match.
    expect(fastifyPathToOpenApi('', '/')).toBe('/')
  })

  it('positive control: prefixed routes are unchanged by that fix', () => {
    expect(fastifyPathToOpenApi('/agents', '/')).toBe('/agents')
    expect(fastifyPathToOpenApi('/agents', '/:id')).toBe('/agents/{id}')
    expect(fastifyPathToOpenApi('', '/health')).toBe('/health')
  })

  it('is in the spec, unauthenticated, and promises no version string', () => {
    const root = (openapiSpec.paths as unknown as Record<string, { get?: { security?: unknown[] } }>)['/']
    expect(root?.get).toBeDefined()
    expect(root?.get?.security).toEqual([])
    const schema = (openapiSpec.components.schemas as unknown as Record<string, { properties?: Record<string, unknown> }>)
      .ApiRootDocument
    expect(schema).toBeDefined()
    // A service banner that fingerprints the deployment is a gift to a scanner
    // and buys an agent nothing.
    for (const forbidden of ['version', 'build', 'commit', 'environment', 'env']) {
      expect(schema?.properties, forbidden).not.toHaveProperty(forbidden)
    }
  })
})
