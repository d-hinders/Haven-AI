/**
 * #3032 (epic #3028 slice 4, independent prep) — 401 before 400 on the two
 * route modules that still authenticated AFTER request validation.
 *
 * Request validation runs in `preValidation`. `agent-passports.ts` (a
 * module-level `preHandler`) and `agent-connection-setups.ts` (four per-route
 * `preHandler`s) authenticated later than that, so once either module is
 * enforced an ANONYMOUS off-spec request would answer the schema's 400 before
 * the 401 — telling a caller with no session which shapes the route accepts.
 * Shadow mode refuses nothing, so today's order still answers 401; this file
 * assembles the app the way enforcement will (#3030 measured the same defect
 * on the device routes and `/analytics/funnel`).
 *
 * The CONTROL case matters: an AUTHENTICATED off-spec request must answer 400,
 * proving validation really is enforced here. Without it, every 401 below
 * could pass because nothing was validating at all.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installRequestValidation } from '../../openapi/request-validation.js'
import agentPassportRoutes from '../agent-passports.js'
import agentConnectionSetupRoutes from '../agent-connection-setups.js'

const UUID = '11111111-1111-4111-8111-111111111111'

let app: FastifyInstance
let token = ''

beforeAll(async () => {
  app = Fastify({ logger: false })
  installRequestValidation(app, {
    mode: 'enforce',
    enforcedModules: ['routes/agent-passports.ts', 'routes/agent-connection-setups.ts'],
  })
  await app.register(fastifyJwt, { secret: 'test-secret' })
  await app.register(agentPassportRoutes, { prefix: '/agents' })
  await app.register(agentConnectionSetupRoutes, { prefix: '/agent-connection-setups' })
  await app.ready()
  token = app.jwt.sign({ sub: 'user-1', email: 'owner@example.com' })
})

afterAll(async () => app.close())

// Every owner-authenticated operation in the two modules, each with an
// off-spec variant (a non-uuid path param, or a create body missing `name`).
const CASES = [
  { label: 'GET /agents/:id/passport', method: 'GET', ok: `/agents/${UUID}/passport`, off: '/agents/not-a-uuid/passport' },
  { label: 'POST /agents/:id/passport', method: 'POST', ok: `/agents/${UUID}/passport`, off: '/agents/not-a-uuid/passport' },
  { label: 'POST /agent-connection-setups', method: 'POST', ok: '/agent-connection-setups', off: '/agent-connection-setups', okBody: { name: 'x' }, offBody: {} },
  { label: 'GET /agent-connection-setups/:setupId', method: 'GET', ok: `/agent-connection-setups/${UUID}`, off: '/agent-connection-setups/not-a-uuid' },
  { label: 'POST /agent-connection-setups/:setupId/budget-approval', method: 'POST', ok: `/agent-connection-setups/${UUID}/budget-approval`, off: '/agent-connection-setups/not-a-uuid/budget-approval' },
  { label: 'POST /agent-connection-setups/:setupId/cancel', method: 'POST', ok: `/agent-connection-setups/${UUID}/cancel`, off: '/agent-connection-setups/not-a-uuid/cancel' },
] as const

describe('401 before 400 with the two modules ENFORCED (#3032)', () => {
  for (const c of CASES) {
    it(`${c.label}: anonymous → 401, whether the request is on-spec or off-spec`, async () => {
      const onSpec = await app.inject({ method: c.method, url: c.ok, ...('okBody' in c ? { payload: c.okBody } : {}) })
      expect(onSpec.statusCode, onSpec.body).toBe(401)
      // Mutation: auth back on `preHandler` → this answers the schema's 400.
      const offSpec = await app.inject({ method: c.method, url: c.off, ...('offBody' in c ? { payload: c.offBody } : {}) })
      expect(offSpec.statusCode, offSpec.body).toBe(401)
    })

    it(`${c.label}: CONTROL — authenticated and off-spec → 400 (validation really is enforced)`, async () => {
      const res = await app.inject({
        method: c.method,
        url: c.off,
        headers: { authorization: `Bearer ${token}` },
        ...('offBody' in c ? { payload: c.offBody } : {}),
      })
      expect(res.statusCode, res.body).toBe(400)
    })
  }
})
