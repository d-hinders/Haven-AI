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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { readFile } from 'node:fs/promises'

// A plain fn the probe handlers await — no module mock here: nothing in this
// file's import graph imports the DB, and a vi.mock of a module the scanner
// cannot resolve breaks the mock-factory census equation (261 ≠ 262).
const mockQuery = vi.fn()

import { installRequestValidation, requestValidationOpsSnapshot, requestSchemaForOperation, prefixIsEnforced } from '../request-validation.js'
import { openapiSpec } from '../spec.js'
import { makeSpecAjv, REQUEST_AJV_OPTIONS } from '../ajv.js'

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
    const params = (schema?.params?.properties ?? {}) as Record<string, unknown>
    expect(params.id).toMatchObject({ format: 'uuid' })
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
    const params = (schema?.params?.properties ?? {}) as Record<string, unknown>
    const query = (schema?.querystring?.properties ?? {}) as Record<string, unknown>
    expect(params.id).toMatchObject({ format: 'uuid' })
    expect(query.limit).toMatchObject({ type: 'integer', minimum: 1 })
    expect(query.offset).toMatchObject({ type: 'integer', minimum: 0 })
  })
})

describe('the OPEN-budget body against the REAL spec and the REAL request ajv (#3082)', () => {
  // The defect that blocked agent onboarding, pinned at the layer that caused
  // it. Not a hand-built schema: this reads the shipped operation out of
  // `openapiSpec` and compiles it with the same ajv options the plugin
  // installs, so a regression in EITHER the spec declaration or the ajv
  // options fails here.
  const BUILD = '/agents/{id}/delegations/build'

  function compileBody() {
    const operation = (openapiSpec.paths as Record<string, Record<string, unknown>>)[BUILD].post
    const schema = requestSchemaForOperation(operation as never)
    expect(schema?.body, `${BUILD} must declare a request body`).toBeTruthy()
    const ajv = makeSpecAjv(
      { ...REQUEST_AJV_OPTIONS, closeObjects: false },
      openapiSpec.components.schemas as never,
    )
    return ajv.compile(schema!.body as never)
  }

  const OPEN_BUDGET = {
    token_address: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    recipient_address: null,
    budget_atomic: '1000000',
    period_seconds: 86400,
  }

  it('an OPEN budget (recipient_address: null) VALIDATES', () => {
    expect(compileBody()(structuredClone(OPEN_BUDGET))).toBe(true)
  })

  it('and null is NOT rewritten to "" — the coercion that caused #3082', () => {
    const body = structuredClone(OPEN_BUDGET)
    compileBody()(body)
    // `routes/agent-delegations.ts` guards with `recipient_address != null`.
    // An `''` here is indistinguishable from a caller pinning a recipient to
    // the empty string, and it is what produced
    // `400 recipient_address must be a valid address when set` on every
    // budget grant.
    expect(body.recipient_address).toBeNull()
  })

  it('a PINNED budget still validates, and a malformed pin still does not', () => {
    // The nullable declaration must not have widened the field into "anything
    // goes": `pattern` constrains strings and ignores null, so a real address
    // passes and a short one is still refused.
    const pinned = { ...structuredClone(OPEN_BUDGET), recipient_address: '0x' + 'ab'.repeat(20) }
    expect(compileBody()(pinned)).toBe(true)
    const malformed = { ...structuredClone(OPEN_BUDGET), recipient_address: '0xdead' }
    expect(compileBody()(malformed)).toBe(false)
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
    // The x402 characterization surface: mounted at the REAL prefix
    // (routes/x402.ts:203) so the plugin resolves the REAL /x402/authorize
    // operation and injects its schema. The probe handler only echoes that
    // the request arrived — shadow's job is to observe, not to run x402.
    await app.register(x402AuthorizeProbeRoutes, { prefix: '/x402' })
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
    await auth('POST', '/contacts', { name: 'Acme', address: '0x' + 'ab'.repeat(20) })
    expect(requestValidationOpsSnapshot().wouldRefuse).toBe(before)
  })

  it('the shadow counter records route+field and /health/ops shape via requestValidationOpsSnapshot', async () => {
    const before = requestValidationOpsSnapshot()
    await auth('POST', '/contacts', { name: 'Acme' })
    const after = requestValidationOpsSnapshot()

    expect(after.wouldRefuse).toBe(before.wouldRefuse + 1)
    expect(after.mode).toBe('shadow')
    const added = Object.keys(after.byRouteField).filter((k) => !(k in before.byRouteField) || after.byRouteField[k] !== before.byRouteField[k])
    expect(added.length).toBe(1)
    expect(added[0]).toMatch(/^POST \/contacts body/)
  })

  it('#3082: shadow does NOT mutate the request body — null survives ajv coercion', async () => {
    // This assertion read `address: ''` until #3082 — as a characterization
    // of the defect, not as an intended contract. The schema is attached in
    // shadow mode too and REQUEST_AJV_OPTIONS sets `coerceTypes: 'array'`,
    // so ajv rewrote the body IN PLACE and the handler was handed something
    // the client never sent.
    //
    // That broke shadow's documented promise — "no behaviour change on any
    // currently-accepted request" — and it is how #3082 blocked agent
    // onboarding on dev: the dashboard sends `recipient_address: null` for an
    // OPEN budget, `routes/agent-delegations.ts`'s `!= null` guard saw `''`,
    // and every budget grant 400'd.
    const res = await auth('POST', '/contacts', { name: 'Acme', address: null })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ created: { name: 'Acme', address: null } })
  })

  it('#3082: the instrument still fires — an unmutated body is still COUNTED as a would-refusal', async () => {
    // The fix restores the body; it must not also silence the measurement
    // epic #3028 exists to gather. `address: null` is genuinely off-spec
    // against a `type: 'string'` declaration, so the counter must still move
    // even though the handler now sees the client's `null`.
    const before = requestValidationOpsSnapshot().wouldRefuse
    const res = await auth('POST', '/contacts', { name: 'Acme', address: null })
    expect(res.json()).toEqual({ created: { name: 'Acme', address: null } })
    expect(requestValidationOpsSnapshot().wouldRefuse).toBe(before + 1)
  })

  it('CONTROL (#3082): a conformant body reaches the handler byte-for-byte', async () => {
    // Proves the instrument can say "unchanged" before its "changed" above is
    // used as evidence (#2444). Same route, same assertion shape.
    const address = '0x' + 'ab'.repeat(20)
    const res = await auth('POST', '/contacts', { name: 'Acme', address })
    expect(res.json()).toEqual({ created: { name: 'Acme', address } })
  })

  it('#3082: a COERCIBLE off-spec body is counted as would_coerce — the divergence a refusal never shows', async () => {
    // Restoring the body is what makes this silent, so the same snapshot
    // measures it. `name: 42` validates CLEAN after coercion to "42", so it
    // raises no would-refusal — yet the handler would receive a different
    // value the moment this route is enforced. Epic #3028 flips money-path
    // modules on these readings.
    const before = requestValidationOpsSnapshot()
    const res = await auth('POST', '/contacts', { name: 42, address: '0x' + 'ab'.repeat(20) })
    const after = requestValidationOpsSnapshot()

    // The client's value reached the handler untouched...
    expect(res.json()).toEqual({ created: { name: 42, address: '0x' + 'ab'.repeat(20) } })
    // ...and the divergence was recorded rather than hidden.
    expect(after.wouldCoerce).toBe(before.wouldCoerce + 1)
    expect(Object.keys(after.coerceByRouteField)).toContain('POST /contacts name')
    // It is NOT a would-refusal: coercion made it valid, which is the whole point.
    expect(after.wouldRefuse).toBe(before.wouldRefuse)
  })

  it('#3082: a body needing no coercion moves NEITHER counter', async () => {
    const before = requestValidationOpsSnapshot()
    await auth('POST', '/contacts', { name: 'Acme', address: '0x' + 'ab'.repeat(20) })
    const after = requestValidationOpsSnapshot()
    expect(after.wouldCoerce).toBe(before.wouldCoerce)
    expect(after.wouldRefuse).toBe(before.wouldRefuse)
  })

  it('a typed query parameter (limit=10, a string on the wire) is ACCEPTED — coercion proven', async () => {
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

  it('CHARACTERIZATION: POST /x402/authorize with settlementScheme is NOT refused in shadow — it logs (#3029, the gap slice 3 closes)', async () => {
    // The shipped SDK sends `settlementScheme`; the spec's X402AuthorizeRequest
    // is additionalProperties: false and does not declare it — a known,
    // owner-acknowledged spec gap. Shadow must DEMONSTRATE it (one would_refuse
    // line, the request continues) and this slice must NOT fix the spec
    // (a spec correction is a contract change: slice 3, #3031).
    const lines: unknown[] = []
    const originalInfo = app.log.info.bind(app.log)
    ;(app.log as unknown as { info: (o: unknown, m?: string) => void }).info = (obj, msg) => {
      if (msg === 'request_validation.would_refuse') lines.push(obj)
      return originalInfo(obj as never, msg as never)
    }

    const before = requestValidationOpsSnapshot()
    const res = await auth('POST', '/x402/authorize', {
      url: 'https://merchant.example/mcp',
      payTo: '0x' + 'ab'.repeat(20),
      amount: '20000',
      asset: '0x' + 'cd'.repeat(20),
      network: 'base',
      settlementScheme: 'erc7710',
    })

    // The route continues on its normal path — the probe answers, not a 400.
    expect(res.statusCode).toBe(200)
    // Exactly one would_refuse, naming the field the spec does not declare.
    expect(lines.length).toBe(1)
    expect(lines[0]).toMatchObject({
      event: 'request_validation.would_refuse',
      route: 'POST /x402/authorize',
    })
    expect(String((lines[0] as { field: string }).field)).toMatch(/^body\/settlementScheme$/)
    expect(String((lines[0] as { message: string }).message)).toMatch(/additional/)
    // And the counter moved.
    expect(requestValidationOpsSnapshot().wouldRefuse).toBe(before.wouldRefuse + 1)
    ;(app.log as unknown as { info: typeof originalInfo }).info = originalInfo
  })

  it('CHARACTERIZATION: the same x402 body WITHOUT settlementScheme produces no refusal at all', async () => {
    // Proves the log above is caused by the undeclared field specifically —
    // the conformant shape passes the spec as written today.
    const before = requestValidationOpsSnapshot()
    const res = await auth('POST', '/x402/authorize', {
      url: 'https://merchant.example/mcp',
      payTo: '0x' + 'ab'.repeat(20),
      amount: '20000',
      asset: '0x' + 'cd'.repeat(20),
      network: 'base',
    })
    expect(res.statusCode).toBe(200)
    expect(requestValidationOpsSnapshot().wouldRefuse).toBe(before.wouldRefuse)
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
    // Echoes the body the HANDLER received, not the one the client sent —
    // that difference is the whole subject of the #3082 tests below.
    const body = request.body as Record<string, unknown>
    await mockQuery('INSERT INTO contacts')
    return { created: { ...body } }
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

// The x402 characterization surface: the REAL prefix (routes/x402.ts:203) and
// a handler that only echoes arrival. The plugin resolves the REAL
// /x402/authorize operation and injects X402AuthorizeRequest — the probe never
// touches the x402 module, so this exercises ONLY the validation edge.
async function x402AuthorizeProbeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', (req, reply, done) => {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      void reply.code(401).send({ error: 'Unauthorized' })
      return
    }
    ;(req as unknown as { user: { sub: string } }).user = { sub: USER }
    done()
  })

  app.post('/authorize', async () => ({ authorized: true }))
}

// The header of the source file under test must keep its registration contract
// documented — a cheap source pin that the spike findings stay written down.
it('the plugin header keeps the spiked fastify contract documented', async () => {
  const source = await readFile(new URL('../request-validation.ts', import.meta.url), 'utf8')
  expect(source).toContain('validateParam')
  expect(source).toContain('attachValidation === false')
  expect(source).toContain('ROOT-SCOPE')
})
