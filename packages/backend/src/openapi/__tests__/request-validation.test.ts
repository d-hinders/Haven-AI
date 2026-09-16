import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { readFile } from 'node:fs/promises'

/**
 * The request-validation plugin's own contract (#3029, epic #3028 slice 1).
 *
 * This file is deliberately NOT a route test — the module has no routes of its
 * own. It pins the plugin's modes against a minimal probe module whose shape
 * mirrors a real route file (`GET /` + a POST with a requestBody + typed
 * query/path params on a spec'd GET), using the REAL spec via the
 * `/contacts` operation where a requestBody is needed. The route-level
 * behaviour on the proof module lives in `routes/__tests__/contacts.test.ts`.
 */

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))
vi.mock('../db.js', () => ({ default: { query: (...args: unknown[]) => mockQuery(...args) } }))

import { installRequestValidation, requestValidationOpsSnapshot, requestSchemaForOperation, prefixIsEnforced } from '../request-validation.js'
import { openapiSpec } from '../spec.js'

const USER = 'user-1'

describe('requestSchemaForOperation (#3029)', () => {
  const spec = openapiSpec as unknown as {
    paths: Record<string, Record<string, Record<string, any>>>
  }

  it('builds body + params + querystring from the spec operation', () => {
    const put = spec.paths['/contacts/{id}'].put
    const schema = requestSchemaForOperation(put)
    expect(schema).not.toBeNull()
    expect(schema?.body).toMatchObject({ type: 'object', required: ['name'] })
    expect(schema?.params).toMatchObject({ type: 'object' })
    expect(schema?.params?.properties?.id).toMatchObject({ format: 'uuid' })
    expect(schema?.params?.required).toEqual(['id'])
    expect(schema?.querystring).toBeUndefined()
  })

  it('returns null when the operation declares no request constraints (GET /contacts)', () => {
    const get = spec.paths['/contacts'].get
    expect(requestSchemaForOperation(get)).toBeNull()
  })

  it('merges path-item parameters beneath operation parameters (OpenAPI override rule)', () => {
    // /agent-activity/{id}/activity carries path + query params on the operation.
    const get = spec.paths['/agent-activity/{id}/activity'].get
    const schema = requestSchemaForOperation(get)
    expect(schema?.params?.properties?.id).toMatchObject({ format: 'uuid' })
    expect(schema?.querystring?.properties?.limit).toMatchObject({ type: 'integer', minimum: 1 })
    expect(schema?.querystring?.properties?.offset).toMatchObject({ type: 'integer', minimum: 0 })
  })
})

describe('prefixIsEnforced (#3029)', () => {
  it('matches the exact mount and anything beneath it, nothing else', () => {
    expect(prefixIsEnforced('/contacts', ['/contacts'])).toBe(true)
    expect(prefixIsEnforced('/contacts/sub', ['/contacts'])).toBe(true)
    expect(prefixIsEnforced('/contacts-elsewhere', ['/contacts'])).toBe(false)
    expect(prefixIsEnforced('/catalog', ['/contacts'])).toBe(false)
  })
})

describe('installRequestValidation — shadow mode (#3029)', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    installRequestValidation(app, { mode: 'shadow' })
    await app.register(contactProbeRoutes, { prefix: '/contacts' })
    // The same module mounted twice is the repo's own twin-mount precedent
    // (userSafesRoutes at index.ts) — this mount owns the spec'd GET
    // /agent-activity/{id}/activity the coercion proof rides.
    await app.register(contactProbeRoutes, { prefix: '/agent-activity' })
    token = app.jwt.sign({ sub: USER, email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  function auth(method: 'GET' | 'POST', url: string, payload?: object) {
    return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload })
  }

  it('an off-spec body takes the NORMAL path — status and body unchanged', async () => {
    // The spec's POST /contacts schema requires `address`; the probe handler
    // itself never validates. Shadow must not change the answer.
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const res = await auth('POST', '/contacts', { name: 'Acme' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ created: { name: 'Acme' } })
  })

  it('exactly ONE structured would_refuse line per off-spec request', async () => {
    const lines: unknown[] = []
    const originalInfo = app.log.info.bind(app.log)
    ;(app.log as unknown as { info: (o: unknown, m?: string) => void }).info = (obj, msg) => {
      if (msg === 'request_validation.would_refuse') lines.push(obj)
      return originalInfo(obj as never, msg as never)
    }

    mockQuery.mockResolvedValueOnce({ rows: [] })
    await auth('POST', '/contacts', { name: 'Acme' })

    expect(lines.length).toBe(1)
    expect(lines[0]).toMatchObject({
      event: 'request_validation.would_refuse',
      route: 'POST /contacts',
    })
    expect(String((lines[0] as { field: string }).field)).toMatch(/address|required/)
    ;(app.log as unknown as { info: typeof originalInfo }).info = originalInfo
  })

  it('a conformant body produces NO log line and no counter movement', async () => {
    const before = requestValidationOpsSnapshot().wouldRefuse
    mockQuery.mockResolvedValueOnce({ rows: [] })
    await auth('POST', '/contacts', { name: 'Acme', address: '0x' + 'ab'.repeat(20) })
    expect(requestValidationOpsSnapshot().wouldRefuse).toBe(before)
  })

  it('the shadow counter records route+field and /health/ops shape via requestValidationOpsSnapshot', async () => {
    const before = requestValidationOpsSnapshot()
    mockQuery.mockResolvedValueOnce({ rows: [] })
    await auth('POST', '/contacts', { name: 'Acme' })
    const after = requestValidationOpsSnapshot()

    expect(after.wouldRefuse).toBe(before.wouldRefuse + 1)
    expect(after.mode).toBe('shadow')
    const added = Object.keys(after.byRouteField).filter((k) => !(k in before.byRouteField) || after.byRouteField[k] !== before.byRouteField[k])
    expect(added.length).toBe(1)
    expect(added[0]).toMatch(/^POST \/contacts body/)
  })

  it('a typed query parameter (limit=10, a string on the wire) is ACCEPTED — coercion proven', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    // /agent-activity/{id}/activity is the spec'd GET with typed params
    // (uuid path, integer limit/offset query) — the plugin injects its schema.
    const res = await auth('GET', '/agent-activity/7c41b8e0-2d95-4a63-b1f7-8e5c39a0d264/activity?limit=10')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ limit: 10, type: 'number', id: '7c41b8e0-2d95-4a63-b1f7-8e5c39a0d264' })
  })

  it('a malformed uuid path param is LOGGED, not refused, in shadow — the request continues', async () => {
    const before = requestValidationOpsSnapshot()
    const res = await auth('GET', '/agent-activity/not-a-uuid/activity')
    // Shadow continues: the handler's own answer, unchanged. (Fastify validates
    // params -> body -> query and stops at the first failure, so on a
    // params-refused request the query part is never reached — the handler's
    // `?? 30` fallback answers, exactly as without the plugin.)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ limit: 30, type: 'undefined', id: 'not-a-uuid' })
    const after = requestValidationOpsSnapshot()
    expect(after.wouldRefuse).toBe(before.wouldRefuse + 1)
    const added = Object.keys(after.byRouteField).filter((k) => !(k in before.byRouteField))
    expect(added.length).toBe(1)
    expect(added[0]).toMatch(/^GET \/agent-activity\/:id\/activity params\/id$/)
  })
})

describe('installRequestValidation — off mode (#3029)', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    installRequestValidation(app, { mode: 'off' })
    await app.register(contactProbeRoutes, { prefix: '/contacts' })
    token = app.jwt.sign({ sub: USER, email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('NOTHING runs: off-spec body passes with no log line and the counter unmoved', async () => {
    const lines: unknown[] = []
    const originalInfo = app.log.info.bind(app.log)
    ;(app.log as unknown as { info: (o: unknown, m?: string) => void }).info = (obj, msg) => {
      if (msg === 'request_validation.would_refuse') lines.push(obj)
      return originalInfo(obj as never, msg as never)
    }

    const before = requestValidationOpsSnapshot()
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'POST',
      url: '/contacts',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Acme' },
    })

    expect(res.statusCode).toBe(200)
    expect(lines.length).toBe(0)
    expect(requestValidationOpsSnapshot()).toEqual({ ...before, mode: 'off' })
    ;(app.log as unknown as { info: typeof originalInfo }).info = originalInfo
  })

  it('off does not disable an enforcedPrefixes module — the proof-module override holds', async () => {
    // Re-installed below in its own app; asserted there. Here we pin that the
    // OFF app did not inject a schema at all (the probe answers regardless).
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'POST',
      url: '/contacts',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Acme', address: 'garbage' },
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('installRequestValidation — enforce mode (#3029)', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    // The app-level handler the enforced route delegates to — production has
    // httpErrorHandler (#1464); the shape is what matters here.
    app.setErrorHandler((error: FastifyError, _request, reply) => {
      const statusCode = error.statusCode ?? 500
      void reply.status(statusCode).send({ error: error.message })
    })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    // enforcedPrefixes flips the module REGARDLESS of the env mode — proven by
    // pairing mode:'off' with the contacts prefix enforced.
    installRequestValidation(app, { mode: 'off', enforcedPrefixes: ['/contacts'] })
    await app.register(contactProbeRoutes, { prefix: '/contacts' })
    token = app.jwt.sign({ sub: USER, email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('mode:off + enforcedPrefixes still refuses with the 400 envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/contacts',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Acme' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({
      error: 'Request does not match the API spec',
      statusCode: 400,
      error_code: 'invalid_request',
    })
  })

  it('a non-validation error on an enforced route keeps the app handler answer', async () => {
    const res = await app.inject({ method: 'GET', url: '/contacts/boom', headers: { authorization: `Bearer ${token}` } })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ error: 'probe boom' })
  })
})

// ── The probe module: mirrors a real route file's registration shape ─────────

async function contactProbeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', (req, reply, done) => {
    // Minimal auth stand-in: a JWT-shaped token must be present.
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      void reply.code(401).send({ error: 'Unauthorized' })
      return
    }
    ;(req as unknown as { user: { sub: string } }).user = { sub: USER }
    done()
  })

  app.get('/', async (request) => {
    await mockQuery('SELECT 1')
    return { contacts: [] as unknown[] }
  })

  app.post('/', async (request) => {
    const body = request.body as { name: string }
    await mockQuery('INSERT INTO contacts')
    return { created: { name: body.name } }
  })

  // A spec'd GET with typed path + query params (uuid + integer limit,
  // default 30) — the coercion proof surface. Mounted at the REAL spec path
  // /agent-activity/{id}/activity so the plugin resolves the operation and
  // injects the schema; the handler echoes what it received.
  app.get('/:id/activity', async (request) => {
    await mockQuery('SELECT 1')
    const query = request.query as { limit?: number }
    const params = request.params as { id: string }
    return { limit: query.limit ?? 30, type: typeof query.limit, id: params.id }
  })

  app.get('/boom', async () => {
    const err = new Error('probe boom')
    ;(err as unknown as { statusCode: number }).statusCode = 503
    throw err
  })
}

// The header of the source file under test must keep its registration contract
// documented — a cheap source pin that the spike findings stay written down.
it('the plugin header keeps the spiked fastify contract documented', async () => {
  const source = await readFile(new URL('../request-validation.ts', import.meta.url), 'utf8')
  expect(source).toContain('validateParam')
  expect(source).toContain('attachValidation === false')
  expect(source).toContain('ROOT-SCOPE')
})
