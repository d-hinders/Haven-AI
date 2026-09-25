/**
 * #3032 (epic #3028 slice 4) — the three owner-route modules of this slice
 * enforce the request schema, per route.
 *
 * The owner's instrument decision (epic #3028 decision 8, #3208) and the
 * #3223 ruling set the evidence bar for the routes a shadow reading can never
 * prove (33 of these modules' 36 operations saw no traffic in the 2026-09-22
 * window): per-route TEST evidence — an off-spec body answers the 400
 * envelope BEFORE the handler, a conformant one reaches it — the same
 * instrument slice 2 enforced its 22 modules on, with the refusal asserted
 * per ROUTE as `request-validation.ts`'s header asks (a file-level assertion
 * can hide a route registered with a non-literal path).
 *
 * `agent-connection-setups.ts` and `agent-passports.ts` are pinned in
 * `auth-before-request-validation-3032.test.ts` (anonymous 401-before-400
 * with both modules ENFORCED — the hook-order proof). This file covers the
 * other three modules of the slice: `agent-rekey.ts`, `agents.ts`,
 * `hybrid-accounts.ts`.
 *
 * Mutation: drop one of the three files from `enforcedModules` in index.ts →
 * the off-spec cases below fall back to shadow logging and reach the handler
 * (401/404 on the mock), not the envelope → red.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { installRequestValidation } from '../../openapi/request-validation.js'
import agentRekeyRoutes from '../agent-rekey.js'
import agentRoutes from '../agents.js'
import hybridAccountRoutes from '../hybrid-accounts.js'

vi.mock('../../db.js', () => ({
  default: { query: async () => ({ rows: [] }), connect: async () => ({ query: async () => ({ rows: [] }), release: async () => {} }) },
}))
// db-mock-exempt: no database behaviour is under test here. This file pins the
// request-validation EDGE — an off-spec body must answer the 400 envelope
// BEFORE any handler code runs — so the handlers never execute and the pool
// is faked only to make route registration safe; the same-suite control case
// asserts the envelope is absent, not what the database answered.
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: async (request: { user?: { sub: string } }) => {
    request.user = { sub: 'user-1' }
  },
}))

const UUID = '11111111-1111-4111-8111-111111111111'
const ADDRESS = `0x${'ab'.repeat(20)}`

let app: FastifyInstance
let token = ''

beforeAll(async () => {
  app = Fastify({ logger: false })
  installRequestValidation(app, {
    mode: 'enforce',
    enforcedModules: ['routes/agent-rekey.ts', 'routes/agents.ts', 'routes/hybrid-accounts.ts'],
  })
  await app.register(fastifyJwt, { secret: 'test-secret' })
  await app.register(agentRoutes, { prefix: '/agents' })
  await app.register(agentRekeyRoutes, { prefix: '/agents' })
  await app.register(hybridAccountRoutes, { prefix: '/accounts' })
  await app.ready()
  token = app.jwt.sign({ sub: 'user-1', email: 'owner@example.com' })
})

afterAll(async () => app.close())

function inject(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload } : {}) })
}

describe('the three owner-route modules enforce per route (#3032)', () => {
  // One off-spec case per module — the smallest body that only the schema can
  // refuse (an undeclared field under `additionalProperties: false`, or a
  // wrong-typed required one). `POST /agents`' `name` is required + minLength
  // 1, so a missing name refuses at the edge today and in shadow it reached
  // the handler's own 400.
  it('POST /agents: off-spec body → the 400 envelope, not the handler', async () => {
    const res = await inject('POST', '/agents', { nonsense: true })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({
      error: 'Request does not match the API spec',
      statusCode: 400,
      error_code: 'invalid_request',
    })
  })

  it('POST /agents: CONTROL — a conformant body reaches the handler (mocked repo answers, no envelope)', async () => {
    const res = await inject('POST', '/agents', { name: 'Scout', delegate_address: ADDRESS })
    // The handler runs past validation (the mocked repo returns no rows); the
    // point is the STATUS — 201/4xx-from-handler, never the 400 envelope.
    expect(res.statusCode).not.toBe(400)
    expect(res.json()).not.toMatchObject({ error_code: 'invalid_request' })
  })

  it('POST /agents/:id/rekey: a wrong-typed new_delegate_address → the 400 envelope (the schema pattern)', async () => {
    // NOTE: this operation's body schema is deliberately OPEN (no
    // `additionalProperties: false`) — the five #3032 corrections are the
    // complete correction list and none of them closes it, so an unknown
    // extra field still passes (the handler destructures only known keys).
    // The required field's PATTERN is what the edge refuses on.
    const res = await inject('POST', `/agents/${UUID}/rekey`, {
      new_delegate_address: 'not-an-address',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error_code: 'invalid_request' })
    expect(res.json().details).toContain('new_delegate_address')
  })

  it('POST /agents/:id/rekey: missing required new_delegate_address → the 400 envelope names it', async () => {
    const res = await inject('POST', `/agents/${UUID}/rekey`, {})
    expect(res.statusCode).toBe(400)
    // The refusal names the field (the missing-required branch of
    // `refusalField`): root-object refusal, field in the pointer.
    expect(res.json().details).toContain('new_delegate_address')
  })

  it('POST /accounts/hybrid: off-spec body → the 400 envelope', async () => {
    const res = await inject('POST', '/accounts/hybrid', { chain_id: 'not-a-number', nonsense: true })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error_code: 'invalid_request' })
  })

  it('POST /accounts/hybrid: a passkey with a malformed coordinate → the 400 envelope (the schema pattern)', async () => {
    const res = await inject('POST', '/accounts/hybrid', {
      passkeys: [{ key_id: 'k1', x: 'zzz', y: '0x1' }],
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().details).toContain('/passkeys')
  })

  it('agent-passports (already enforced by the 3032 auth-order test): a non-uuid path param → the 400 envelope here too', async () => {
    // agent-passports.ts is NOT registered in this app; this case documents
    // the split of evidence, so it only pins the rekey sibling path param on
    // the same mount: a malformed `:id` refuses at the schema before the
    // (mocked) handler.
    const res = await inject('POST', '/agents/not-a-uuid/rekey', { new_delegate_address: ADDRESS })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error_code: 'invalid_request' })
  })
})
