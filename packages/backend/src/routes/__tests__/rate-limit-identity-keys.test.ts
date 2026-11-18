import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'

/**
 * #4955: the shared rate-limit key is the identity the route's auth VERIFIED,
 * never the raw text of a header — asserted through the REAL plugin, the REAL
 * auth hooks and the REAL route modules, wired the way `index.ts` wires them
 * (non-global, `rateLimitKeyFor` as the key generator; the plugin's in-memory
 * store instead of the Postgres one, which the key derivation does not touch).
 *
 * Each request carries an empty body, so the enforced request validation
 * answers 400 after the limiter has counted it: no handler, chain read or
 * database write is reached, and the only status that differs is the 429.
 */

const AGENTS = new Map<string, string>() // sha256(key) → agent id

vi.mock('../../infra/repositories/agents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/repositories/agents.js')>()
  return {
    ...actual,
    findAgentAuthRowByApiKeyHash: vi.fn(async (hash: string) => {
      const id = AGENTS.get(hash)
      if (!id) return null
      return {
        id,
        user_id: `owner-of-${id}`,
        name: id,
        delegate_address: '0x00000000000000000000000000000000000000d1',
        account_address: '0x00000000000000000000000000000000000000a1',
        chain_id: 84532,
        status: 'active',
        archived_at: null,
        execution_rail: null,
        account_type: null,
        mcp_server_name: null,
        has_bound_account: true,
      }
    }),
    touchAgentLastSeenRow: vi.fn(async () => {}),
  }
})

const { rateLimitKeyFor, moneyPathRateLimit, opsRevealRateLimit } = await import('../../middleware/rate-limit.js')
const { installRequestValidation } = await import('../../openapi/request-validation.js')
const { createOpsAuth } = await import('../../middleware/ops-auth.js')
const { signOpsToken } = await import('../../modules/ops/tokens.js')
const paymentRoutes = (await import('../payments.js')).default
const x402Routes = (await import('../x402.js')).default
const hybridAccountRoutes = (await import('../hybrid-accounts.js')).default

const LIMIT = moneyPathRateLimit.rateLimit.max

/** A fresh agent key per test, so no test spends another's bucket. */
function agentKey(name: string): string {
  const key = `sk_agent_${name}_${'k'.repeat(24)}`
  AGENTS.set(createHash('sha256').update(key).digest('hex'), `agent-${name}`)
  return key
}

const OPS_SECRET = 'ops-test-secret-at-least-32-bytes-long!!'
const OPS_ORIGIN = 'https://api.test.example'

describe('rate-limit keys follow the verified identity (#4955)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(rateLimit, {
      global: false,
      keyGenerator: (request: FastifyRequest) => rateLimitKeyFor(request),
    })
    installRequestValidation(app, {
      mode: 'enforce',
      enforcedModules: ['routes/payments.ts', 'routes/x402.ts', 'routes/hybrid-accounts.ts'],
    })
    await app.register(paymentRoutes, { prefix: '/payments' })
    await app.register(x402Routes, { prefix: '/x402' })
    await app.register(hybridAccountRoutes, { prefix: '/accounts' })

    // The ops reveal tier behind the real ops auth hook, in the same
    // route-level `onRequest` position `routes/ops.ts` gives it.
    const opsAuth = createOpsAuth({
      jwtSecret: OPS_SECRET,
      publicOrigin: OPS_ORIGIN,
      allowedGithubIds: [101, 202],
    } as never)
    app.post('/ops/reveal', { onRequest: opsAuth, config: opsRevealRateLimit }, async () => ({ ok: true }))
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  async function statuses(n: number, send: (i: number) => Promise<{ statusCode: number }>): Promise<number[]> {
    const out: number[] = []
    for (let i = 0; i < n; i++) out.push((await send(i)).statusCode)
    return out
  }

  const AGENT_ROUTES = [
    { name: 'POST /payments', url: '/payments' },
    { name: 'POST /x402/authorize', url: '/x402/authorize' },
    { name: 'POST /payments/:id/sign', url: '/payments/00000000-0000-4000-8000-000000000001/sign' },
  ]

  describe('a junk Authorization beside a valid X-API-Key does not open a fresh bucket', () => {
    for (const route of AGENT_ROUTES) {
      it(`${route.name}: request ${LIMIT + 1} is 429 although every request carries a different junk Bearer`, async () => {
        const key = agentKey(`junk${route.url.length}`)
        const codes = await statuses(LIMIT + 1, (i) =>
          app.inject({
            method: 'POST',
            url: route.url,
            headers: { authorization: `Bearer junk-${i}`, 'x-api-key': key },
            payload: {},
          }),
        )
        // Admitted by agent auth (never 401) on every request …
        expect(codes.filter((c) => c === 401)).toEqual([])
        // … and counted in ONE bucket: only the request past the limit is refused.
        expect(codes.slice(0, LIMIT).filter((c) => c === 429)).toEqual([])
        expect(codes[LIMIT]).toBe(429)
      })
    }
  })

  it('one agent key shares one bucket whether it arrives as Bearer or as X-API-Key', async () => {
    const key = agentKey('both-headers')
    const codes = await statuses(LIMIT + 1, (i) =>
      app.inject({
        method: 'POST',
        url: '/payments',
        headers: i % 2 === 0 ? { authorization: `Bearer ${key}` } : { 'x-api-key': key },
        payload: {},
      }),
    )
    expect(codes.slice(0, LIMIT).filter((c) => c === 429)).toEqual([])
    expect(codes[LIMIT]).toBe(429)
    // Another agent from the same address is untouched: the bucket is the
    // agent, not a per-IP collapse that would also have refused request 61.
    const other = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { 'x-api-key': agentKey('both-headers-other') },
      payload: {},
    })
    expect(other.statusCode).not.toBe(429)
    expect(other.statusCode).not.toBe(401)
  })

  describe('owners stay apart', () => {
    const OWNER_URL = '/accounts/hybrid/0x00000000000000000000000000000000000000a1/transfers/prepare'
    const owner = (sub: string, n = 0) =>
      ({ authorization: `Bearer ${app.jwt.sign({ sub, email: `${sub}+${n}@test.example` })}` })

    it('two owners from one address keep separate buckets on a money-path owner route', async () => {
      const a = owner('owner-a')
      const b = owner('owner-b')
      const codesA = await statuses(LIMIT + 1, () =>
        app.inject({ method: 'POST', url: OWNER_URL, headers: a, payload: {} }),
      )
      expect(codesA.filter((c) => c === 401)).toEqual([])
      expect(codesA[LIMIT]).toBe(429)
      // Owner B, same IP, is untouched by A's exhausted bucket.
      const first = await app.inject({ method: 'POST', url: OWNER_URL, headers: b, payload: {} })
      expect(first.statusCode).not.toBe(429)
      expect(first.statusCode).not.toBe(401)
    })

    it("two sessions of ONE owner share that owner's bucket (keyed on the verified sub, not the token text)", async () => {
      const tab1 = owner('owner-c', 1)
      const tab2 = owner('owner-c', 2)
      expect(tab1.authorization).not.toBe(tab2.authorization)
      const codes = await statuses(LIMIT + 1, (i) =>
        app.inject({ method: 'POST', url: OWNER_URL, headers: i % 2 === 0 ? tab1 : tab2, payload: {} }),
      )
      expect(codes.slice(0, LIMIT).filter((c) => c === 429)).toEqual([])
      expect(codes[LIMIT]).toBe(429)
    })

    it('two ops operators keep separate buckets on ops reveal', async () => {
      const token = (githubId: number) =>
        ({
          authorization: `Bearer ${signOpsToken({ secret: OPS_SECRET, issuer: OPS_ORIGIN }, { githubId, login: `op${githubId}` })}`,
        })
      const max = opsRevealRateLimit.rateLimit.max
      const codes = await statuses(max + 1, () =>
        app.inject({ method: 'POST', url: '/ops/reveal', headers: token(101) }),
      )
      expect(codes.slice(0, max)).toEqual(Array(max).fill(200))
      expect(codes[max]).toBe(429)
      const other = await app.inject({ method: 'POST', url: '/ops/reveal', headers: token(202) })
      expect(other.statusCode).toBe(200)
    })
  })
})
